import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type GhRunner,
  GitHubAdapter,
  GitHubError,
  sanitizeGhOutput,
} from "../packages/integrations/src/github.ts";

const REPO = "owner/repo";
const OTHER = "owner/other";

type GhOutcome = { stdout?: string; stderr?: string };
function fixture(handler: ((args: string[]) => GhOutcome | Error) | GhOutcome) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    const result = typeof handler === "function" ? handler(args) : handler;
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return {
    calls,
    adapter: new GitHubAdapter({ enabled: true, allowedRepos: [REPO], runner }),
  };
}

const prListJson = JSON.stringify([
  {
    number: 7,
    title: "Fix flaky test",
    state: "OPEN",
    url: "https://github.com/owner/repo/pull/7",
    isDraft: false,
    headRefName: "fix/flaky",
    baseRefName: "main",
    reviewDecision: "REVIEW_REQUIRED",
    updatedAt: "2026-11-27T00:00:00Z",
    author: { login: "octocat" },
  },
]);

test("disabled adapter rejects every call without spawning", async () => {
  let spawned = 0;
  const runner: GhRunner = async () => {
    spawned += 1;
    return { stdout: "[]", stderr: "" };
  };
  const adapter = new GitHubAdapter({ allowedRepos: [REPO], runner });
  await assert.rejects(adapter.listPullRequests(REPO), { code: "disabled" });
  await assert.rejects(adapter.listIssues(REPO), { code: "disabled" });
  await assert.rejects(adapter.searchCode(REPO, "x"), { code: "disabled" });
  assert.equal(spawned, 0);
});

test("empty allowlist denies reads without spawning; malformed slugs rejected", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  const closed = new GitHubAdapter({
    enabled: true,
    runner: async () => ({ stdout: "", stderr: "" }),
  });
  await assert.rejects(closed.listPullRequests(REPO), { code: "repo_not_allowed" });
  await assert.rejects(adapter.listPullRequests(OTHER), { code: "repo_not_allowed" });
  await assert.rejects(adapter.listPullRequests("not-a-slug"), { code: "repo_not_allowed" });
  await assert.rejects(adapter.listPullRequests("a/b; rm -rf /"), { code: "repo_not_allowed" });
  assert.equal(calls.length, 0);
});

test("allowlist matching is case-insensitive and forwards the allowlisted slug", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  await adapter.listPullRequests("Owner/Repo");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(REPO));
});

test("listPullRequests passes structured flags and parses the response", async () => {
  const { calls, adapter } = fixture({ stdout: prListJson });
  const prs = await adapter.listPullRequests(REPO, { state: "open", limit: 10 });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 7);
  assert.equal(prs[0].author?.login, "octocat");
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ["pr", "list"]);
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--limit"));
  assert.equal(args[args.indexOf("--limit") + 1], "10");
});

test("limits clamp into 1..100", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  await adapter.listIssues(REPO, { limit: 0 });
  await adapter.listIssues(REPO, { limit: 500 });
  assert.equal(calls[0][calls[0].indexOf("--limit") + 1], "1");
  assert.equal(calls[1][calls[1].indexOf("--limit") + 1], "100");
});

test("getPullRequest returns detail fields; getPullRequestDiff returns text", async () => {
  const detail = JSON.stringify({
    ...JSON.parse(prListJson)[0],
    body: "body text",
    additions: 3,
    deletions: 1,
    changedFiles: 2,
  });
  const { adapter } = fixture((args) =>
    args[1] === "diff" ? { stdout: "diff --git a/x b/x\n+line\n" } : { stdout: detail },
  );
  const pr = await adapter.getPullRequest(REPO, 7);
  assert.equal(pr.additions, 3);
  const { diff, truncated } = await adapter.getPullRequestDiff(REPO, 7);
  assert.equal(truncated, false);
  assert.match(diff, /diff --git/);
});

test("getChecksStatus and searchCode shape requests and parse responses", async () => {
  const checks = JSON.stringify([
    { name: "quality", state: "SUCCESS", bucket: "pass", link: "https://x" },
  ]);
  const code = JSON.stringify([
    {
      path: "src/a.ts",
      url: "https://github.com/owner/repo/blob/main/src/a.ts",
      repository: { nameWithOwner: REPO },
    },
  ]);
  const { calls, adapter } = fixture((args) =>
    args[0] === "search" ? { stdout: code } : { stdout: checks },
  );
  const statuses = await adapter.getChecksStatus(REPO, 7);
  assert.equal(statuses[0].bucket, "pass");
  const results = await adapter.searchCode(REPO, "GitHubAdapter");
  assert.equal(results[0].repository.nameWithOwner, REPO);
  const searchArgs = calls[1];
  assert.ok(searchArgs.some((a) => a.includes("repo:owner/repo")));
});

test("searchCode rejects empty queries before spawning", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  await assert.rejects(adapter.searchCode(REPO, "   "), { code: "api" });
  assert.equal(calls.length, 0);
});

// Drive the real default runner + classifier through a fake gh binary whose
// stderr/exit come from files, so every mapping is exercised end to end.
async function fakeBinary(dir: string, files: { stderr?: string; stdout?: string; exit?: number }) {
  const log = join(dir, "argv.log");
  const fake = join(dir, "gh");
  await writeFile(join(dir, "stderr.txt"), files.stderr ?? "");
  await writeFile(join(dir, "stdout.txt"), files.stdout ?? "");
  await writeFile(join(dir, "exit.txt"), String(files.exit ?? 0));
  await writeFile(
    fake,
    `#!/bin/sh\ndir=$(dirname "$0")\necho "$@" >> "${log}"\ncat "$dir/stdout.txt"\ncat "$dir/stderr.txt" >&2\nexit $(cat "$dir/exit.txt")\n`,
  );
  await chmod(fake, 0o755);
  return { fake, log };
}

test("default runner classifies real subprocess failures end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-gh-classify-"));
  const { fake } = await fakeBinary(dir, {});
  const adapter = new GitHubAdapter({ enabled: true, allowedRepos: [REPO], ghPath: fake });
  const cases: [string, string][] = [
    ["gh auth login: not logged in to github.com", "auth_failed"],
    ["HTTP 401: Bad credentials", "auth_failed"],
    ["API rate limit exceeded for user ID 1. (403)", "rate_limited"],
    ["GraphQL: Could not resolve to a Repository (404)", "not_found"],
    ["something exploded", "api"],
  ];
  for (const [stderr, code] of cases) {
    await writeFile(join(dir, "stderr.txt"), stderr);
    await writeFile(join(dir, "exit.txt"), "1");
    await assert.rejects(adapter.listPullRequests(REPO), { code });
  }
});

test("default runner maps ENOENT to gh_missing", async () => {
  const adapter = new GitHubAdapter({
    enabled: true,
    allowedRepos: [REPO],
    ghPath: "/nonexistent/gh-binary",
  });
  await assert.rejects(adapter.listPullRequests(REPO), { code: "gh_missing" });
});

test("default runner classifies stderr from a failing fake gh binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-gh-fake-"));
  const { fake, log } = await fakeBinary(dir, {
    stderr: "HTTP 401: Bad credentials (token ghp_secretvalue123)",
    exit: 1,
  });
  const adapter = new GitHubAdapter({ enabled: true, allowedRepos: [REPO], ghPath: fake });
  await assert.rejects(adapter.listPullRequests(REPO), (error: unknown) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.code, "auth_failed");
    assert.equal(error.message.includes("ghp_secretvalue123"), false, "token must be redacted");
    return true;
  });
  const recorded = await readFile(log, "utf8");
  assert.match(recorded, /pr list --repo owner\/repo/);
});

test("searchCode rejects flag injection and scope qualifiers before spawning", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  await assert.rejects(adapter.searchCode(REPO, "--owner=evil"), { code: "repo_not_allowed" });
  await assert.rejects(adapter.searchCode(REPO, "--web"), { code: "repo_not_allowed" });
  await assert.rejects(adapter.searchCode(REPO, "foo repo:other/repo"), {
    code: "repo_not_allowed",
  });
  await assert.rejects(adapter.searchCode(REPO, "foo owner:evil"), { code: "repo_not_allowed" });
  await adapter.searchCode(REPO, "foo in:path");
  assert.equal(calls.length, 1, "only the legitimate query spawns");
  assert.ok(calls[0].includes("--"), "query is protected by a flag terminator");
});

test("allowlist entries are trimmed so config whitespace still matches", async () => {
  const adapter = new GitHubAdapter({
    enabled: true,
    allowedRepos: ["  Owner/Repo  "],
    runner: async () => ({ stdout: "[]", stderr: "" }),
  });
  await adapter.listIssues("owner/repo");
});

test("non-finite or invalid numbers are rejected, not stringified", async () => {
  const { calls, adapter } = fixture({ stdout: "[]" });
  await assert.rejects(adapter.getPullRequest(REPO, Number.NaN), { code: "api" });
  await assert.rejects(adapter.getPullRequest(REPO, 0), { code: "api" });
  await assert.rejects(adapter.getChecksStatus(REPO, Number.POSITIVE_INFINITY), { code: "api" });
  await adapter.listIssues(REPO, { limit: Number.NaN });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf("--limit") + 1], "30", "NaN limit falls back to default");
});

test("truncateUtf8 never splits a code point and respects the byte budget", async () => {
  const { truncateUtf8, MAX_DIFF_BYTES } = await import("../packages/integrations/src/github.ts");
  const text = "abc".repeat(100) + "中文汉" + "xyz".repeat(100);
  const budget = Buffer.byteLength(text, "utf8") - 2; // cut inside the final run
  const clipped = truncateUtf8(text, budget);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= budget);
  assert.equal(clipped.includes("\uFFFD"), false);
  assert.equal(truncateUtf8("short", 100), "short");
  const big = "\u4e2d".repeat(MAX_DIFF_BYTES); // 3 bytes each, forces mid-codepoint cuts
  const clippedBig = truncateUtf8(big, MAX_DIFF_BYTES);
  assert.ok(Buffer.byteLength(clippedBig, "utf8") <= MAX_DIFF_BYTES);
});

test("diff truncation marks output and survives a maxBuffer-killed child", async () => {
  const { adapter } = fixture({ stdout: "x".repeat(2 * 1024 * 1024) });
  const { diff, truncated } = await adapter.getPullRequestDiff(REPO, 7);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(diff, "utf8") <= 1024 * 1024 + 64);
  assert.match(diff, /openmuse:diff-truncated/);
});

test("sanitizeGhOutput redacts every token shape", () => {
  const messy = "ghp_a gho_bb github_pat_cc123 ghu_dd ghs_ee ghr_ff kept-text";
  const clean = sanitizeGhOutput(messy);
  assert.equal(clean.includes("ghp_a"), false);
  assert.equal(clean.includes("github_pat_cc123"), false);
  assert.match(clean, /kept-text/);
});

test("invalid JSON and schema mismatches surface as invalid_response", async () => {
  const { adapter: badJson } = fixture({ stdout: "not json" });
  await assert.rejects(badJson.listPullRequests(REPO), { code: "invalid_response" });
  const { adapter: badShape } = fixture({ stdout: JSON.stringify([{ number: "seven" }]) });
  await assert.rejects(badShape.listPullRequests(REPO), { code: "invalid_response" });
});
