import { randomUUID } from "node:crypto";
import { GitHubAdapter } from "../../../packages/integrations/src/github.ts";
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

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    options: { fetch?: FetchLike; adapter?: GitHubAdapter } = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.adapter =
      options.adapter ??
      new GitHubAdapter({
        enabled: Boolean(config.githubEnabled),
        allowedRepos: config.githubAllowedRepos ?? [],
      });
  }

  githubAdapter(): GitHubAdapter {
    return this.adapter;
  }

  configured(): boolean {
    return this.config.githubEnabled === true;
  }

  /** The active connection, or null. PAT records that cannot be decrypted raise a diagnosable 503. */
  async connection(owner: string): Promise<GitHubConnectionInfo | null> {
    if (!this.configured()) return null;
    if (this.config.githubAuthMode === "pat") {
      const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
      if (!stored?.secret) return null;
      return { ...this.decode(stored.secret), mode: "pat", host: this.host() };
    }
    try {
      const user = await this.adapter.getAuthenticatedUser();
      return {
        id: "gh-cli",
        account: user.login,
        scopes: [],
        mode: "gh-cli",
        host: this.host(),
      };
    } catch {
      return null;
    }
  }

  async connected(owner: string): Promise<boolean> {
    return (await this.connection(owner)) !== null;
  }

  private host(): string {
    return this.config.githubApiHost ?? "https://api.github.com";
  }

  private decode(secret: string): Omit<GitHubConnectionInfo, "mode" | "host"> & { token: string } {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    let parsed: StoredToken;
    try {
      parsed = JSON.parse(decryptSecret(secret, this.config.encryptionKey));
    } catch {
      throw new AppError(
        "Stored GitHub credential cannot be decrypted. Check TOKEN_ENCRYPTION_KEY, then reconnect.",
        503,
      );
    }
    return {
      id: parsed.connectionId,
      account: parsed.account,
      scopes: parsed.scopes,
      token: parsed.token,
    };
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
    await this.db.put(owner, "credentials", {
      id: CREDENTIAL_ID,
      connectionId: stored.connectionId,
      account: stored.account,
      scopes: stored.scopes,
      secret: encryptSecret(JSON.stringify(stored), this.config.encryptionKey),
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
   * the credential is cleared and every connection-bound pending proposal is
   * expired. Returns the remaining connection, if any.
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
      await this.invalidate(owner, connection.id);
      return null;
    }
    return connection;
  }

  /** Disconnect and expire every proposal bound to the current connection. */
  async disconnect(owner: string): Promise<void> {
    const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
    await this.invalidate(owner, stored?.connectionId ?? undefined);
  }

  /**
   * Clear the credential and expire its pending work: every awaiting_review
   * proposal bound to this connection becomes expired, and its waiting_approval
   * task moves to waiting_input with an actionable question.
   */
  async invalidate(owner: string, connectionId?: string): Promise<void> {
    const stored = await this.db.get<Credential>(owner, "credentials", CREDENTIAL_ID);
    const bound = connectionId ?? stored?.connectionId ?? null;
    if (stored)
      await this.db.put(owner, "credentials", {
        id: CREDENTIAL_ID,
        connectionId: null,
        account: null,
        scopes: [],
        secret: null,
      });
    if (!bound) return;
    const proposals = await this.db.list<{
      id: string;
      status: string;
      connectionId?: string;
      taskId?: string;
    }>(owner, "actions");
    for (const proposal of proposals) {
      if (proposal.status !== "awaiting_review" || proposal.connectionId !== bound) continue;
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
