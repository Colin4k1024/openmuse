import { randomUUID } from "node:crypto";
import {
  type GhRunner,
  GitHubAdapter,
  GitHubError,
} from "../../../packages/integrations/src/github.ts";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * GitHub connection lifecycle (docs/GITHUB-INTEGRATION.md).
 *
 * Two auth modes: "gh-cli" derives the connection live from `gh auth` (no token
 * is ever stored); "pat" stores a fine-grained personal access token encrypted
 * with the vault envelope under TOKEN_ENCRYPTION_KEY. Token invalidation
 * expires every connection-bound awaiting_review proposal and moves its task
 * to waiting_input, mirroring the Google account-change semantics.
 */

export interface GitHubConnectionInfo {
  id: string;
  account: string;
  scopes: string[];
  mode: "gh-cli" | "pat";
  host: string;
}

interface Credential {
  id: string;
  connectionId: string | null;
  account?: string | null;
  scopes?: string[];
  secret: string | null;
}

interface StoredToken {
  connectionId: string;
  account: string;
  scopes: string[];
  token: string;
}

const CREDENTIAL_ID = "github";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubAuth {
  private readonly adapter: GitHubAdapter;
  private readonly fetchFn: FetchLike;
  private readonly runner?: GhRunner;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    options: { fetch?: FetchLike; adapter?: GitHubAdapter; runner?: GhRunner } = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.runner = options.runner;
    this.adapter =
      options.adapter ??
      new GitHubAdapter({
        enabled: Boolean(config.githubEnabled),
        allowedRepos: config.githubAllowedRepos ?? [],
        runner: options.runner,
      });
  }

  /**
   * An adapter carrying the current connection's credentials. pat mode injects
   * GH_TOKEN (and GH_HOST for Enterprise); gh-cli mode inherits the server
   * session. Throws 409 when no connection exists.
   */
  async adapterFor(owner: string): Promise<GitHubAdapter> {
    if (!this.configured())
      throw new AppError("GitHub integration is disabled (GITHUB_ENABLED=false)", 409);
    const base = {
      enabled: true,
      allowedRepos: this.config.githubAllowedRepos ?? [],
      writeEnabled: this.config.githubWriteEnabled === true,
      runner: this.runner,
    };
    if (this.config.githubAuthMode === "pat") {
      const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
      if (!stored?.secret) throw new AppError("Connect GitHub before using its tools", 409);
      const { token } = this.decode(stored.secret);
      const host = this.host();
      const env: Record<string, string> = { GH_TOKEN: token };
      if (host !== "https://api.github.com") env.GH_HOST = new URL(host).host;
      return new GitHubAdapter({ ...base, env });
    }
    return new GitHubAdapter(base);
  }

  githubAdapter(): GitHubAdapter {
    return this.adapter;
  }

  configured(): boolean {
    return this.config.githubEnabled === true;
  }

  /** The active connection, or null. Never carries the token. Undecryptable PAT records raise a diagnosable 503. */
  async connection(owner: string): Promise<GitHubConnectionInfo | null> {
    if (!this.configured()) return null;
    if (this.config.githubAuthMode === "pat") {
      const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
      if (!stored?.secret) return null;
      const { connectionId, account, scopes } = this.decode(stored.secret);
      return { id: connectionId, account, scopes, mode: "pat", host: this.host() };
    }
    const probe = await this.probeCli();
    if (probe.state !== "connected") return null;
    return { id: "gh-cli", account: probe.account, scopes: [], mode: "gh-cli", host: this.host() };
  }

  async connected(owner: string): Promise<boolean> {
    return (await this.connection(owner)) !== null;
  }

  private async probeCli(): Promise<
    { state: "connected"; account: string } | { state: "unavailable"; detail: string }
  > {
    try {
      const user = await this.adapter.getAuthenticatedUser();
      return { state: "connected", account: user.login };
    } catch (error) {
      const detail =
        error instanceof GitHubError
          ? error.code === "gh_missing"
            ? "GitHub CLI is not installed on the server. Install gh, then run gh auth login."
            : error.code === "auth_failed"
              ? "gh is not authenticated. Run gh auth login on the server."
              : `gh probe failed (${error.code}): ${error.message}`
          : `gh probe failed: ${error instanceof Error ? error.message : "unknown error"}`;
      return { state: "unavailable", detail };
    }
  }

  /**
   * Operator-facing status. Distinguishes not-installed from not-authenticated,
   * and re-validates a stored PAT (expiring it on 401) so status never reports
   * a revoked token as connected.
   */
  async probe(
    owner: string,
  ): Promise<
    | { state: "disabled" }
    | { state: "unavailable"; detail: string }
    | { state: "connected"; connection: GitHubConnectionInfo }
  > {
    if (!this.configured()) return { state: "disabled" };
    if (this.config.githubAuthMode === "pat") {
      let connection: GitHubConnectionInfo | null;
      try {
        connection = await this.validate(owner);
      } catch (error) {
        // Local credential faults (undecryptable record, missing key) stay
        // diagnosable 503s; only genuine network failures degrade to unavailable.
        if (error instanceof AppError) throw error;
        // A network failure is not a revoked token: never invalidate, degrade to unavailable.
        return {
          state: "unavailable",
          detail: `GitHub is unreachable: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      }
      return connection
        ? { state: "connected", connection }
        : { state: "unavailable", detail: "No valid stored token. Connect a fine-grained PAT." };
    }
    const cli = await this.probeCli();
    if (cli.state !== "connected") return cli;
    const connection = await this.connection(owner);
    return connection
      ? { state: "connected", connection }
      : { state: "unavailable", detail: "gh probe failed" };
  }

  private host(): string {
    return this.config.githubApiHost ?? "https://api.github.com";
  }

  private decode(secret: string): StoredToken {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    try {
      return JSON.parse(decryptSecret(secret, this.config.encryptionKey));
    } catch {
      throw new AppError(
        "Stored GitHub credential cannot be decrypted. Check TOKEN_ENCRYPTION_KEY, then reconnect.",
        503,
      );
    }
  }

  /** Validate and store a fine-grained PAT. Nothing is stored when GitHub rejects it. */
  async connectWithToken(owner: string, token: string): Promise<GitHubConnectionInfo> {
    if (!this.configured())
      throw new AppError("GitHub integration is disabled (GITHUB_ENABLED=false)", 409);
    if (this.config.githubAuthMode !== "pat")
      throw new AppError("GITHUB_AUTH_MODE is not pat; authenticate with gh auth login", 409);
    const trimmed = token.trim();
    if (!trimmed) throw new AppError("A GitHub token is required", 400);
    const response = await this.fetchFn(`${this.host()}/user`, {
      headers: {
        authorization: `Bearer ${trimmed}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401)
      throw new AppError("GitHub rejected the token (401). Create a fresh fine-grained PAT.", 401);
    if (!response.ok)
      throw new AppError(`GitHub token validation failed (HTTP ${response.status})`, 502);
    const body = (await response.json()) as { login?: string };
    if (!body.login) throw new AppError("GitHub token validation returned no login", 502);
    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const stored: StoredToken = {
      connectionId: randomUUID(),
      account: body.login,
      scopes,
      token: trimmed,
    };
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    let secret: string;
    try {
      secret = encryptSecret(JSON.stringify(stored), this.config.encryptionKey);
    } catch (error) {
      throw new AppError(
        `GitHub credential could not be encrypted: ${error instanceof Error ? error.message : "unknown"}`,
        503,
      );
    }
    // Replacing a connection invalidates the old one: its pending proposals must
    // not stay approvable for an account the server no longer controls.
    const previous = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
    if (previous?.connectionId) await this.expireProposals(owner, previous.connectionId);
    await this.db.put(owner, "credentials", {
      id: CREDENTIAL_ID,
      connectionId: stored.connectionId,
      account: stored.account,
      scopes: stored.scopes,
      secret,
    });
    return {
      id: stored.connectionId,
      account: stored.account,
      scopes: stored.scopes,
      mode: "pat",
      host: this.host(),
    };
  }

  /**
   * Re-validate a stored PAT against GitHub. A 401 invalidates the connection:
   * the credential is cleared (only if unchanged since we read it) and every
   * connection-bound pending proposal is expired. Returns the remaining
   * connection, if any. Called from the status route; the write path (#6)
   * calls it again before executing approvals.
   */
  async validate(owner: string): Promise<GitHubConnectionInfo | null> {
    const connection = await this.connection(owner);
    if (!connection || connection.mode !== "pat") return connection;
    const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
    if (!stored?.secret) return null;
    const { token } = this.decode(stored.secret);
    const response = await this.fetchFn(`${this.host()}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401) {
      await this.invalidateSnapshot(owner, stored);
      return null;
    }
    return connection;
  }

  /** Disconnect and expire every proposal bound to the current connection. */
  async disconnect(owner: string): Promise<void> {
    for (;;) {
      const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
      if (!stored) return;
      const cleared = await this.db.compareAndSwap<Credential>(
        owner,
        "credentials",
        CREDENTIAL_ID,
        { ...stored },
        { connectionId: null, account: null, scopes: [], secret: null },
      );
      if (!cleared) continue; // raced a concurrent connect; re-read and retry
      if (stored.connectionId) await this.expireProposals(owner, stored.connectionId);
      return;
    }
  }

  /**
   * Clear the credential and expire its pending work, but only when the stored
   * row still matches what the caller observed (no TOCTOU against reconnects).
   * Used by the write path (#6) when GitHub answers 401 mid-execution.
   */
  async invalidate(owner: string, connectionId?: string): Promise<void> {
    const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
    if (!stored) return;
    if (connectionId && stored.connectionId && stored.connectionId !== connectionId) return;
    await this.invalidateSnapshot(owner, stored);
  }

  private async invalidateSnapshot(owner: string, stored: Credential): Promise<void> {
    const cleared = await this.db.compareAndSwap<Credential>(
      owner,
      "credentials",
      CREDENTIAL_ID,
      { ...stored },
      { connectionId: null, account: null, scopes: [], secret: null },
    );
    if (!cleared) return; // row changed under us; leave the newer connection alone
    if (stored.connectionId) await this.expireProposals(owner, stored.connectionId);
  }

  /** Every awaiting_review proposal bound to the connection expires; its waiting_approval task moves to waiting_input. */
  private async expireProposals(owner: string, connectionId: string): Promise<void> {
    const proposals = await this.db.list<{
      id: string;
      status: string;
      connectionId?: string;
      taskId?: string;
    }>(owner, "actions");
    for (const proposal of proposals) {
      if (proposal.status !== "awaiting_review" || proposal.connectionId !== connectionId) continue;
      const expired = await this.db.compareAndSwap<{ id: string; status: string }>(
        owner,
        "actions",
        proposal.id,
        { status: "awaiting_review" },
        { status: "expired" },
      );
      if (!expired || !proposal.taskId) continue;
      await this.db.compareAndSwap<{ status: string }>(
        owner,
        "tasks",
        proposal.taskId,
        { status: "waiting_approval" },
        {
          status: "waiting_input",
          question:
            "The GitHub connection behind this action changed or was revoked. Reconnect GitHub, then ask me to prepare the action again.",
        },
      );
    }
  }
}
