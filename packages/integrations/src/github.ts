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
  /** "owner/repo" entries. Empty (or omitted) denies every repository, including reads. */
  allowedRepos?: readonly string[];
  /** Test seam; defaults to spawning `gh`. */
  runner?: GhRunner;
  /** Executable used by the default runner. */
  ghPath?: string;
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
function createGhRunner(ghPath: string): GhRunner {
  return (args) =>
    new Promise<GhResult>((resolve, reject) => {
      execFile(
        ghPath,
        args,
        { maxBuffer: MAX_BUFFER, env: process.env },
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
  private readonly allowlist: ReadonlySet<string>;
  private readonly run: GhRunner;

  constructor(options: GitHubAdapterOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.allowlist = new Set((options.allowedRepos ?? []).map((repo) => repo.trim().toLowerCase()));
    this.run = options.runner ?? createGhRunner(options.ghPath ?? "gh");
  }

  /** Rejects disabled adapters and non-allowlisted repos before any spawn. */
  private authorize(repo: string): string {
    if (!this.enabled)
      throw new GitHubError("disabled", "GitHub integration is disabled (GITHUB_ENABLED=false).");
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
}
