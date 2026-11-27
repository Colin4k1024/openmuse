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

test("classifies gh failures: auth, rate limit, not found, generic api", async () => {
  const cases: [string, string][] = [
    ["gh auth login: not logged in to github.com", "auth_failed"],
    ["HTTP 401: Bad credentials", "auth_failed"],
    ["API rate limit exceeded for user ID 1. (403)", "rate_limited"],
    ["GraphQL: Could not resolve to a Repository (404)", "not_found"],
    ["something exploded", "api"],
  ];
  for (const [stderr, code] of cases) {
    const { adapter } = fixture(() => {
      throw new GitHubError(
        ((): "auth_failed" | "rate_limited" | "not_found" | "api" => {
          const text = stderr.toLowerCase();
          if (text.includes("rate limit")) return "rate_limited";
          if (text.includes("not logged in") || text.includes("401")) return "auth_failed";
          if (text.includes("404") || text.includes("could not resolve")) return "not_found";
          return "api";
        })(),
        stderr,
      );
    });
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
  const log = join(dir, "argv.log");
  const fake = join(dir, "gh");
  await writeFile(
    fake,
    `#!/bin/sh\necho "$@" >> "${log}"\necho "HTTP 401: Bad credentials (token ghp_secretvalue123)" >&2\nexit 1\n`,
  );
  await chmod(fake, 0o755);
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
