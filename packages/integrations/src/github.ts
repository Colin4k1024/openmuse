import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Read-only GitHub adapter backed by the `gh` CLI. Credential custody stays in
 * `gh auth`; this adapter never reads, logs, or forwards tokens. Every
 * repository access is allowlisted before any subprocess is spawned.
 * Contract: docs/GITHUB-INTEGRATION.md, ADR docs/adr/0001-github-integration.md.
 */

export const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export type GitHubErrorCode =
  | "disabled"
  | "repo_not_allowed"
  | "gh_missing"
  | "auth_failed"
  | "rate_limited"
  | "not_found"
  | "api"
  | "invalid_response";

export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GhResult {
  stdout: string;
  stderr: string;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;

export interface GitHubAdapterOptions {
  /** Defaults to false: a disabled adapter rejects every call without spawning. */
  enabled?: boolean;
  /**
   * Defaults to false: write methods reject without spawning. Writes exist to
   * execute human-approved proposals only (GITHUB_WRITE_ENABLED).
   */
  writeEnabled?: boolean;
  /** "owner/repo" entries. Empty (or omitted) denies every repository, including reads. */
  allowedRepos?: readonly string[];
  /** Test seam; defaults to spawning `gh`. */
  runner?: GhRunner;
  /** Executable used by the default runner. */
  ghPath?: string;
  /** Extra environment for the spawned gh process (e.g. GH_TOKEN in pat mode). */
  env?: Record<string, string>;
}

const authorSchema = z.object({ login: z.string() }).nullable();
const labelSchema = z.object({ name: z.string() });

export const gitHubPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  reviewDecision: z.string().nullable().optional(),
  updatedAt: z.string(),
  author: authorSchema,
});
export const gitHubPullRequestDetailSchema = gitHubPullRequestSchema.extend({
  body: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
});
export const gitHubIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  labels: z.array(labelSchema),
  updatedAt: z.string(),
  author: authorSchema,
});
export const gitHubCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string(),
  link: z.string(),
  description: z.string().optional(),
});
export const gitHubCodeResultSchema = z.object({
  path: z.string(),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
});

export type GitHubPullRequest = z.infer<typeof gitHubPullRequestSchema>;
export type GitHubPullRequestDetail = z.infer<typeof gitHubPullRequestDetailSchema>;
export type GitHubIssue = z.infer<typeof gitHubIssueSchema>;
export type GitHubCheck = z.infer<typeof gitHubCheckSchema>;
export type GitHubCodeResult = z.infer<typeof gitHubCodeResultSchema>;

export const pullRequestStates = ["open", "closed", "merged", "all"] as const;
export const issueStates = ["open", "closed", "all"] as const;
export type PullRequestState = (typeof pullRequestStates)[number];
export type IssueState = (typeof issueStates)[number];

const PR_LIST_FIELDS =
  "number,title,state,url,isDraft,headRefName,baseRefName,reviewDecision,updatedAt,author";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},body,additions,deletions,changedFiles`;
const ISSUE_FIELDS = "number,title,state,url,labels,updatedAt,author";
const CHECK_FIELDS = "name,state,bucket,link,description";
const SEARCH_CODE_FIELDS = "path,url,repository";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_PATTERN = /(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g;

/** Strip token-shaped strings before any stderr reaches an error message. */
export function sanitizeGhOutput(text: string): string {
  return text.replace(TOKEN_PATTERN, "[redacted]");
}

function classifyGhError(stderr: string): GitHubErrorCode {
  const text = stderr.toLowerCase();
  if (text.includes("rate limit") || text.includes("retry-after")) return "rate_limited";
  if (
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("bad credentials") ||
    text.includes("401")
  )
    return "auth_failed";
  if (text.includes("not found") || text.includes("404") || text.includes("could not resolve"))
    return "not_found";
  return "api";
}

/** True when the failure left the server-side outcome unknown (transport/5xx). */
export function isAmbiguousGhError(error: unknown): boolean {
  return (
    error instanceof GitHubError &&
    error.code === "api" &&
    /timeout|timed out|eof|connection|socket|\b50[0234]\b/i.test(error.message)
  );
}

function limit(value: number | undefined): string {
  const parsed = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_LIMIT;
  return String(Math.min(Math.max(parsed, 1), MAX_LIMIT));
}

function positiveInt(value: number, label: string): string {
  if (!Number.isFinite(value) || Math.trunc(value) < 1)
    throw new GitHubError("api", `${label} must be a positive integer, got ${value}.`);
  return String(Math.trunc(value));
}

/** Truncate to at most maxBytes of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  // Back off continuation bytes to the lead byte (or ASCII) at the cut.
  let start = maxBytes;
  while (start > 0 && (buffer[start] & 0b1100_0000) === 0b1000_0000) start -= 1;
  const lead = buffer[start];
  if (lead >= 0x80) {
    const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    // The character starting at `start` extends past the cut: drop it entirely.
    if (start + length > maxBytes) return buffer.subarray(0, start).toString("utf8");
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}

/** Default runner: spawn `gh` without a shell; rejections keep stdout/stderr. */
function createGhRunner(ghPath: string, env?: Record<string, string>): GhRunner {
  return (args) =>
    new Promise<GhResult>((resolve, reject) => {
      execFile(
        ghPath,
        args,
        { maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr });
          const system = error as NodeJS.ErrnoException & { code: string | number };
          if (system.code === "ENOENT") {
            return reject(
              new GitHubError(
                "gh_missing",
                `GitHub CLI not found at "${ghPath}". Install gh and run gh auth login.`,
              ),
            );
          }
          // Oversize output kills the child; keep the partial stdout so callers
          // (diff truncation, JSON validation) degrade predictably instead of
          // surfacing an 8MiB error message.
          if ((system.code as string) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            return resolve({ stdout, stderr: sanitizeGhOutput(stderr) });
          const detail = sanitizeGhOutput(stderr || stdout || String(error));
          reject(
            new GitHubError(
              classifyGhError(detail),
              `gh ${args[0] ?? ""} failed: ${detail}`.trim(),
            ),
          );
        },
      );
    });
}

export class GitHubAdapter {
  private readonly enabled: boolean;
  private readonly writeEnabled: boolean;
  private readonly allowlist: ReadonlySet<string>;
  private readonly run: GhRunner;

  constructor(options: GitHubAdapterOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.writeEnabled = options.writeEnabled ?? false;
    this.allowlist = new Set((options.allowedRepos ?? []).map((repo) => repo.trim().toLowerCase()));
    this.run = options.runner ?? createGhRunner(options.ghPath ?? "gh", options.env);
  }

  private assertEnabled(): void {
    if (!this.enabled)
      throw new GitHubError("disabled", "GitHub integration is disabled (GITHUB_ENABLED=false).");
  }

  /** Rejects disabled adapters and non-allowlisted repos before any spawn. */
  private authorize(repo: string): string {
    this.assertEnabled();
    const normalized = repo.trim().toLowerCase();
    if (!REPO_PATTERN.test(normalized))
      throw new GitHubError(
        "repo_not_allowed",
        `Repository "${repo}" is not a valid owner/repo slug.`,
      );
    if (!this.allowlist.has(normalized))
      throw new GitHubError(
        "repo_not_allowed",
        `Repository "${repo}" is not in GITHUB_ALLOWED_REPOS.`,
      );
    return normalized;
  }

  private async json<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
    const { stdout } = await this.run(args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new GitHubError("invalid_response", `gh returned non-JSON output for: ${args[0]}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success)
      throw new GitHubError(
        "invalid_response",
        `gh output failed validation for ${args[0]}: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    return result.data;
  }

  /** Identity of the authenticated user; repo-independent, needs no allowlist entry. */
  async getAuthenticatedUser(): Promise<{ login: string }> {
    this.assertEnabled();
    return this.json(z.object({ login: z.string() }), ["api", "user"]);
  }

  async listPullRequests(
    repo: string,
    options: { state?: PullRequestState; limit?: number } = {},
  ): Promise<GitHubPullRequest[]> {
    const target = this.authorize(repo);
    return this.json(z.array(gitHubPullRequestSchema), [
      "pr",
      "list",
      "--repo",
      target,
      "--state",
      options.state ?? "open",
      "--limit",
      limit(options.limit),
      "--json",
      PR_LIST_FIELDS,
    ]);
  }

  async getPullRequest(repo: string, number: number): Promise<GitHubPullRequestDetail> {
    const target = this.authorize(repo);
    return this.json(gitHubPullRequestDetailSchema, [
      "pr",
      "view",
      positiveInt(number, "Pull request number"),
      "--repo",
      target,
      "--json",
      PR_VIEW_FIELDS,
    ]);
  }

  /** Plain-text diff, capped at MAX_DIFF_BYTES with a truncation marker. */
  async getPullRequestDiff(
    repo: string,
    number: number,
  ): Promise<{ diff: string; truncated: boolean }> {
    const target = this.authorize(repo);
    const { stdout } = await this.run([
      "pr",
      "diff",
      positiveInt(number, "Pull request number"),
      "--repo",
      target,
    ]);
    if (Buffer.byteLength(stdout, "utf8") <= MAX_DIFF_BYTES)
      return { diff: stdout, truncated: false };
    return {
      diff: `${truncateUtf8(stdout, MAX_DIFF_BYTES)}\n<!-- openmuse:diff-truncated -->`,
      truncated: true,
    };
  }

  async listIssues(
    repo: string,
    options: { state?: IssueState; limit?: number } = {},
  ): Promise<GitHubIssue[]> {
    const target = this.authorize(repo);
    return this.json(z.array(gitHubIssueSchema), [
      "issue",
      "list",
      "--repo",
      target,
      "--state",
      options.state ?? "open",
      "--limit",
      limit(options.limit),
      "--json",
      ISSUE_FIELDS,
    ]);
  }

  async getChecksStatus(repo: string, prNumber: number): Promise<GitHubCheck[]> {
    const target = this.authorize(repo);
    return this.json(z.array(gitHubCheckSchema), [
      "pr",
      "checks",
      positiveInt(prNumber, "Pull request number"),
      "--repo",
      target,
      "--json",
      CHECK_FIELDS,
    ]);
  }

  async searchCode(
    repo: string,
    query: string,
    options: { limit?: number } = {},
  ): Promise<GitHubCodeResult[]> {
    const target = this.authorize(repo);
    const trimmed = query.trim();
    if (!trimmed) throw new GitHubError("api", "Code search requires a non-empty query.");
    // The query is a single positional argument, but cobra still parses leading
    // dashes as flags and GitHub search treats repeated repo:/owner: qualifiers
    // as OR — both would silently escape the allowlist. Reject them outright.
    if (trimmed.startsWith("-") || /\b(repo|owner|org|user):/i.test(trimmed))
      throw new GitHubError(
        "repo_not_allowed",
        "Code search queries cannot contain flags or repo:/owner: qualifiers; the allowlisted repository is always appended.",
      );
    // No "--" terminator: gh (cobra) treats everything after it as positional,
    // which would fold --limit/--json into the query. A single argv element with
    // a rejected leading dash cannot be parsed as a flag, so it is unnecessary.
    return this.json(z.array(gitHubCodeResultSchema), [
      "search",
      "code",
      `${trimmed} repo:${target}`,
      "--limit",
      limit(options.limit),
      "--json",
      SEARCH_CODE_FIELDS,
    ]);
  }

  // ---- Write surface: every method requires writeEnabled and exists to
  // execute human-approved proposals (docs/GITHUB-INTEGRATION.md). ----

  private authorizeWrite(repo: string): string {
    const target = this.authorize(repo);
    if (!this.writeEnabled)
      throw new GitHubError("disabled", "GitHub writes are disabled (GITHUB_WRITE_ENABLED=false).");
    return target;
  }

  /** The head SHA of a branch, or null when it does not exist. */
  async getBranchSha(repo: string, branch: string): Promise<string | null> {
    const target = this.authorize(repo);
    try {
      const ref = await this.json(z.object({ object: z.object({ sha: z.string() }) }), [
        "api",
        `repos/${target}/git/ref/heads/${branch}`,
      ]);
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.code === "not_found") return null;
      throw error;
    }
  }

  /** Create a branch at fromSha; an existing branch at the same SHA is a success. */
  async createBranch(
    repo: string,
    branch: string,
    fromSha: string,
  ): Promise<{ sha: string; created: boolean }> {
    const target = this.authorizeWrite(repo);
    const existing = await this.getBranchSha(target, branch);
    if (existing) {
      if (existing.toLowerCase() === fromSha.toLowerCase())
        return { sha: existing, created: false };
      throw new GitHubError(
        "api",
        `Branch ${branch} already exists at ${existing.slice(0, 12)}, not ${fromSha.slice(0, 12)}.`,
      );
    }
    await this.json(z.looseObject({ ref: z.string() }), [
      "api",
      "-X",
      "POST",
      `repos/${target}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${fromSha}`,
    ]);
    return { sha: fromSha, created: true };
  }

  /** A recent commit on the branch carrying the idempotency trailer, or null. */
  async findCommitByMarker(
    repo: string,
    branch: string,
    marker: string,
  ): Promise<{ sha: string } | null> {
    const target = this.authorize(repo);
    const commits = await this.json(
      z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })),
      ["api", `repos/${target}/commits?sha=${branch}&per_page=20`],
    );
    for (const commit of commits)
      if (commit.commit.message.includes(marker)) return { sha: commit.sha };
    return null;
  }

  /**
   * One commit containing all file changes, via the git trees API. An idemKey adds
   * an Openmuse-Idem trailer so a re-approved identical change returns the
   * existing commit instead of duplicating it.
   */
  async commitFiles(
    repo: string,
    branch: string,
    message: string,
    files: { path: string; content: string }[],
    idemKey?: string,
  ): Promise<{ sha: string; created: boolean }> {
    const target = this.authorizeWrite(repo);
    if (idemKey) {
      const existing = await this.findCommitByMarker(target, branch, `Openmuse-Idem: ${idemKey}`);
      if (existing) return { sha: existing.sha, created: false };
    }
    const base = await this.getBranchSha(target, branch);
    if (!base) throw new GitHubError("not_found", `Branch ${branch} does not exist in ${target}.`);
    const treeArgs = ["api", "-X", "POST", `repos/${target}/git/trees`, "-f", `base_tree=${base}`];
    for (const file of files) {
      treeArgs.push(
        "-f",
        `tree[][path]=${file.path}`,
        "-f",
        "tree[][mode]=100644",
        "-f",
        "tree[][type]=blob",
        "-f",
        `tree[][content]=${file.content}`,
      );
    }
    const tree = await this.json(z.object({ sha: z.string() }), treeArgs);
    const commit = await this.json(z.object({ sha: z.string() }), [
      "api",
      "-X",
      "POST",
      `repos/${target}/git/commits`,
      "-f",
      `message=${idemKey ? `${message}\n\nOpenmuse-Idem: ${idemKey}` : message}`,
      "-f",
      `tree=${tree.sha}`,
      "-f",
      `parents[]=${base}`,
    ]);
    // The ref update is idempotent (same target SHA, fast-forward enforced), so
    // retrying once after an *ambiguous* transport failure is safe; definitive
    // 4xx rejections (e.g. branch protection) are never retried.
    try {
      await this.json(z.looseObject({ ref: z.string() }), [
        "api",
        "-X",
        "PATCH",
        `repos/${target}/git/refs/heads/${branch}`,
        "-f",
        `sha=${commit.sha}`,
      ]);
    } catch (error) {
      if (isAmbiguousGhError(error)) {
        await this.json(z.looseObject({ ref: z.string() }), [
          "api",
          "-X",
          "PATCH",
          `repos/${target}/git/refs/heads/${branch}`,
          "-f",
          `sha=${commit.sha}`,
        ]);
      } else throw error;
    }
    return { sha: commit.sha, created: true };
  }

  /** The open PR for a head branch, or null. */
  async findOpenPrByHead(
    repo: string,
    head: string,
  ): Promise<{ number: number; url: string; title: string } | null> {
    const target = this.authorize(repo);
    const prs = await this.json(
      z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string() })),
      [
        "pr",
        "list",
        "--repo",
        target,
        "--head",
        head,
        "--state",
        "open",
        "--limit",
        "1",
        "--json",
        "number,url,title",
      ],
    );
    return prs[0] ?? null;
  }

  /** Open a PR; an existing open PR from the same head is returned instead of a duplicate. */
  async createPullRequest(
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string; created: boolean }> {
    const target = this.authorizeWrite(repo);
    const existing = await this.findOpenPrByHead(target, head);
    if (existing) return { ...existing, created: false };
    try {
      await this.run([
        "pr",
        "create",
        "--repo",
        target,
        "--head",
        head,
        "--base",
        base,
        "--title",
        title,
        "--body",
        body,
      ]);
    } catch (error) {
      // A racing creator turns into the existing PR, never a duplicate.
      if (error instanceof GitHubError && error.message.toLowerCase().includes("already exists")) {
        const raced = await this.findOpenPrByHead(target, head);
        if (raced) return { ...raced, created: false };
      }
      throw error;
    }
    const created = await this.findOpenPrByHead(target, head);
    if (!created)
      throw new GitHubError(
        "api",
        "gh pr create reported success but no open PR was found for the head branch.",
      );
    return { ...created, created: true };
  }

  /** Find a comment carrying an idempotency marker. */
  async findCommentByMarker(
    repo: string,
    number: number,
    marker: string,
  ): Promise<{ id: number; url: string } | null> {
    const target = this.authorize(repo);
    const pages = await this.json(
      z.array(z.array(z.object({ id: z.number(), body: z.string(), html_url: z.string() }))),
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${target}/issues/${positiveInt(number, "Issue number")}/comments`,
      ],
    );
    for (const page of pages)
      for (const comment of page)
        if (comment.body.includes(marker)) return { id: comment.id, url: comment.html_url };
    return null;
  }

  /** Post a comment with an idempotency marker; a marker hit returns the existing comment. */
  async addComment(
    repo: string,
    number: number,
    body: string,
    idemKey: string,
  ): Promise<{ url: string; created: boolean }> {
    const target = this.authorizeWrite(repo);
    const marker = `<!-- openmuse:idem:${idemKey} -->`;
    const existing = await this.findCommentByMarker(target, number, marker);
    if (existing) return { url: existing.url, created: false };
    const posted = await this.json(z.object({ html_url: z.string() }), [
      "api",
      "-X",
      "POST",
      `repos/${target}/issues/${positiveInt(number, "Issue number")}/comments`,
      "-f",
      `body=${body}\n\n${marker}`,
    ]);
    return { url: posted.html_url, created: true };
  }
}
