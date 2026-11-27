import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  buildDigestSummary,
  type DigestRecord,
  dayKey,
  nextRunAfter,
} from "../apps/server/src/engine/digest.ts";
import { GitHubAuth } from "../apps/server/src/github-auth.ts";
import { type GhRunner, GitHubError } from "../packages/integrations/src/github.ts";

const REPO = "owner/repo";

function config(directory: string, overrides: Partial<Config> = {}): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    githubEnabled: true,
    githubAllowedRepos: [REPO],
    ...overrides,
  } as Config;
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
const issueListJson = JSON.stringify([
  {
    number: 3,
    title: "Docs unclear",
    state: "OPEN",
    url: "https://github.com/owner/repo/issues/3",
    labels: [{ name: "documentation" }],
    updatedAt: "2026-11-27T00:00:00Z",
    author: { login: "octocat" },
  },
]);
const checksJson = JSON.stringify([
  { name: "quality", state: "FAILURE", bucket: "fail", link: "https://x" },
  { name: "platform (web)", state: "SUCCESS", bucket: "pass", link: "https://y" },
]);

function ghFixture(responder: (args: string[]) => string) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    return { stdout: responder(args), stderr: "" };
  };
  return { calls, runner };
}

async function digestServer(t: TestContext, runner: GhRunner) {
  const directory = await mkdtemp(join(tmpdir(), "openfuse-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const cfg = config(directory);
  const auth = new GitHubAuth(db, cfg, { runner });
  const server = await createApp(db, cfg, { github: auth });
  const owner = "digest-owner";
  await server.workspace.ensureSample(owner, server.actions);
  return { db, server, owner };
}

const readOnlyVerbs = new Set(["list", "view", "diff", "checks", "api"]);

test("nextRunAfter and dayKey semantics", () => {
  const morning = new Date(2026, 10, 27, 8, 30);
  assert.equal(nextRunAfter(morning, 9), new Date(2026, 10, 27, 9, 0).toISOString());
  const evening = new Date(2026, 10, 27, 9, 30);
  assert.equal(nextRunAfter(evening, 9), new Date(2026, 10, 28, 9, 0).toISOString());
  assert.match(dayKey(new Date(2026, 10, 7, 23, 59)), /^\d{4}-\d{2}-\d{2}$/);
});

test("buildDigestSummary renders sections deterministically", () => {
  const summary = buildDigestSummary("2026-11-27", [
    {
      repo: REPO,
      openPrs: [{ number: 7, title: "Fix flaky test", url: "https://x/7", draft: false }],
      failingChecks: [{ pr: 7, checks: ["quality"] }],
      openIssues: [
        { number: 3, title: "Docs unclear", url: "https://i/3", labels: ["documentation"] },
      ],
    },
    { repo: "owner/quiet", openPrs: [], failingChecks: [], openIssues: [] },
  ]);
  assert.equal(
    summary,
    [
      "# GitHub digest — 2026-11-27",
      "",
      "## owner/repo",
      "Open PRs (1):",
      "- #7 Fix flaky test — https://x/7",
      "Failing checks:",
      "- PR #7: quality",
      "Open issues (1):",
      "- #3 Docs unclear [documentation] — https://i/3",
      "",
      "## owner/quiet",
      "All clear: no open PRs or issues.",
    ].join("\n"),
  );
});

test("a digest run summarizes repos into a dated artifact and schedules the next day", async (t) => {
  const { calls, runner } = ghFixture((args) =>
    args[1] === "list" && args[0] === "pr"
      ? prListJson
      : args[0] === "issue"
        ? issueListJson
        : checksJson,
  );
  const { db, server, owner } = await digestServer(t, runner);
  const digest = await server.agent.createDigest(owner, { repos: [REPO], hour: 9 });
  assert.equal(digest.status, "active");
  await server.agent.worker.tick();
  const task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "scheduled", task.error ?? task.question);
  const today = dayKey(new Date());
  assert.match(task.result ?? "", new RegExp(`GitHub digest — ${today}`));
  assert.match(task.result ?? "", /PR #7: quality/);
  const record = await db.get<DigestRecord>(owner, "digests", digest.id);
  assert.equal(record?.lastRunDay, today);
  assert.equal(record?.failures, 0);
  assert.ok(Date.parse(task.nextRunAt ?? "") > Date.now(), "next run is in the future");
  const artifacts = await db.list<{ summary: string }>(owner, "agent-artifacts");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].summary, task.result);
  // Every spawned gh call is a read.
  for (const args of calls) assert.ok(readOnlyVerbs.has(args[1] ?? args[0]), args.join(" "));
});

test("a second claim on the same day performs no GitHub calls and writes no artifact", async (t) => {
  const { calls, runner } = ghFixture((args) =>
    args[0] === "issue" ? issueListJson : args[1] === "checks" ? checksJson : prListJson,
  );
  const { db, server, owner } = await digestServer(t, runner);
  const digest = await server.agent.createDigest(owner, { repos: [REPO], hour: 9 });
  await server.agent.worker.tick();
  const callsAfterFirstRun = calls.length;
  assert.ok(callsAfterFirstRun > 0);
  // Simulate a crash-recovery re-claim: force the task runnable again immediately.
  await server.agent.controlDigest(owner, digest.id, "check");
  await server.agent.worker.tick();
  assert.equal(calls.length, callsAfterFirstRun, "same-day re-run is a no-op");
  const artifacts = await db.list(owner, "agent-artifacts");
  assert.equal(artifacts.length, 1, "exactly one artifact for the day");
});

test("GitHub failures back off, and the fifth consecutive failure waits for input", async (t) => {
  const runner: GhRunner = async () => {
    throw new GitHubError("api", "boom");
  };
  const { db, server, owner } = await digestServer(t, runner);
  const digest = await server.agent.createDigest(owner, { repos: [REPO], hour: 9 });
  await server.agent.worker.tick();
  let task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "scheduled");
  let record = await db.get<DigestRecord>(owner, "digests", digest.id);
  assert.equal(record?.failures, 1);
  assert.match(record?.error ?? "", /boom/);
  // Backoff is scheduled minutes ahead, not at the next day.
  const delay = Date.parse(record?.nextRunAt ?? "") - Date.now();
  assert.ok(delay > 0 && delay <= 60 * 60000, `backoff within an hour, got ${delay}ms`);

  await db.put(owner, "digests", { ...record, failures: 4, nextRunAt: new Date().toISOString() });
  await server.agent.controlDigest(owner, digest.id, "check");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "waiting_input");
  assert.match(task.question ?? "", /failed 5 times/);
  record = await db.get<DigestRecord>(owner, "digests", digest.id);
  assert.equal(record?.failures, 5);
});

test("digests reject repos outside the allowlist and a disabled integration", async (t) => {
  const { server, owner } = await digestServer(t, async () => ({ stdout: "[]", stderr: "" }));
  await assert.rejects(server.agent.createDigest(owner, { repos: ["owner/other"], hour: 9 }), {
    status: 422,
  });
  const directory = await mkdtemp(join(tmpdir(), "openfuse-digest-off-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const off = await createApp(db, config(directory, { githubEnabled: false }));
  await assert.rejects(
    server.agent.createDigest && off.agent.createDigest("o", { repos: [REPO], hour: 9 }),
    {
      status: 409,
    },
  );
});

test("pause halts the digest; resume reactivates the same task", async (t) => {
  const { runner } = ghFixture(() => prListJson);
  const { db, server, owner } = await digestServer(t, runner);
  const digest = await server.agent.createDigest(owner, { repos: [REPO], hour: 9 });
  await server.agent.controlDigest(owner, digest.id, "pause");
  let record = await db.get<DigestRecord>(owner, "digests", digest.id);
  assert.equal(record?.status, "paused");
  let task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "paused");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "paused", "paused digest is not claimed");

  await server.agent.controlDigest(owner, digest.id, "resume");
  record = await db.get<DigestRecord>(owner, "digests", digest.id);
  assert.equal(record?.status, "active");
  await server.agent.worker.tick();
  task = await server.agent.getTask(owner, digest.taskId);
  assert.equal(task.status, "scheduled", task.error ?? task.question);
});
