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
  const parsed = Math.trunc(value ?? DEFAULT_LIMIT);
  return String(Math.min(Math.max(parsed, 1), MAX_LIMIT));
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
    this.allowlist = new Set((options.allowedRepos ?? []).map((repo) => repo.toLowerCase()));
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
      String(Math.trunc(number)),
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
    const { stdout } = await this.run(["pr", "diff", String(Math.trunc(number)), "--repo", target]);
    if (Buffer.byteLength(stdout, "utf8") <= MAX_DIFF_BYTES)
      return { diff: stdout, truncated: false };
    const clipped = stdout.slice(0, MAX_DIFF_BYTES);
    return { diff: `${clipped}\n<!-- openmuse:diff-truncated -->`, truncated: true };
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
      String(Math.trunc(prNumber)),
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
    if (!query.trim()) throw new GitHubError("api", "Code search requires a non-empty query.");
    return this.json(z.array(gitHubCodeResultSchema), [
      "search",
      "code",
      `${query.trim()} repo:${target}`,
      "--limit",
      limit(options.limit),
      "--json",
      SEARCH_CODE_FIELDS,
    ]);
  }
}
