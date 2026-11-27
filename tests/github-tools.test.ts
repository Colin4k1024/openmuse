import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { GitHubAuth } from "../apps/server/src/github-auth.ts";
import { type GhRunner, GitHubAdapter, GitHubError } from "../packages/integrations/src/github.ts";
import { modelFixture } from "./helpers/model.ts";

const REPO = "owner/repo";

function baseConfig(directory: string, overrides: Partial<Config> = {}): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...overrides,
  } as Config;
}

function ghFixture(handler: (args: string[]) => { stdout: string; stderr?: string }) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    const result = handler(args);
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { calls, runner };
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

async function githubServer(t: TestContext, config: Config, auth?: GitHubAuth) {
  const directory = await mkdtemp(join(tmpdir(), "openfuse-gh-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  return createApp(db, config, auth ? { github: auth } : {});
}

test("github tools are not registered when the integration is disabled", async (t) => {
  let spawned = 0;
  const runner: GhRunner = async () => {
    spawned += 1;
    return { stdout: "[]", stderr: "" };
  };
  const auth = new GitHubAuth(
    await createStore(),
    baseConfig(await mkdtemp(join(tmpdir(), "openfuse-gh-off-"))),
    { adapter: new GitHubAdapter({ enabled: false, allowedRepos: [REPO], runner }) },
  );
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "github_list_prs", arguments: { repo: REPO } },
    { name: "finish_task", arguments: { summary: "The GitHub tool is unavailable." } },
  ];
  const server = await githubServer(
    t,
    baseConfig(await mkdtemp(join(tmpdir(), "openfuse-gh-"))),
    auth,
  );
  const owner = "gh-disabled";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "List my PRs" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(spawned, 0, "disabled integration must not spawn gh");
  assert.ok(
    requests.some((request) => request.body.includes("github_list_prs")),
    "the model attempted the tool",
  );
});

test("github_list_prs is served from the operations cache on repeat calls and records evidence", async (t) => {
  const { calls: ghCalls, runner } = ghFixture(() => ({ stdout: prListJson }));
  const directory = await mkdtemp(join(tmpdir(), "openfuse-gh-on-"));
  const auth = new GitHubAuth(
    await createStore(),
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    { adapter: new GitHubAdapter({ enabled: true, allowedRepos: [REPO], runner }) },
  );
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "github_list_prs", arguments: { repo: REPO } },
    { name: "github_list_prs", arguments: { repo: REPO } },
    { name: "finish_task", arguments: { summary: "One open PR: Fix flaky test." } },
  ];
  const server = await githubServer(
    t,
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    auth,
  );
  const owner = "gh-cached";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "Summarize open PRs" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(ghCalls.length, 1, "second identical call must hit the operations cache");
  const githubEvidence = finished.evidence.filter((entry) => entry.kind === "github");
  assert.equal(githubEvidence.length, 1);
  assert.equal(githubEvidence[0].id, "github:owner/repo#7");
  assert.equal(githubEvidence[0].url, "https://github.com/owner/repo/pull/7");
  // The final model turn received the tool result exactly once per unique call.
  assert.ok(requests.length >= 3);
});

test("adapter errors reach the model as readable tool errors, not crashes", async (t) => {
  const runner: GhRunner = async () => {
    throw new GitHubError("auth_failed", "gh is not authenticated. Run gh auth login.");
  };
  const directory = await mkdtemp(join(tmpdir(), "openfuse-gh-err-"));
  const auth = new GitHubAuth(
    await createStore(),
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    { adapter: new GitHubAdapter({ enabled: true, allowedRepos: [REPO], runner }) },
  );
  await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "github_list_issues", arguments: { repo: REPO } },
    {
      name: "finish_task",
      arguments: { summary: "GitHub is not authenticated; reconnect and retry." },
    },
  ];
  const server = await githubServer(
    t,
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    auth,
  );
  const owner = "gh-error";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "List issues" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.match(finished.result ?? "", /not authenticated/i);
});

test("repos outside the allowlist are rejected with an actionable error", async (t) => {
  const { calls: ghCalls, runner } = ghFixture(() => ({ stdout: "[]" }));
  const directory = await mkdtemp(join(tmpdir(), "openfuse-gh-allow-"));
  const auth = new GitHubAuth(
    await createStore(),
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    { adapter: new GitHubAdapter({ enabled: true, allowedRepos: [REPO], runner }) },
  );
  await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "github_list_prs", arguments: { repo: "owner/secret" } },
    { name: "finish_task", arguments: { summary: "owner/secret is not allowlisted." } },
  ];
  const server = await githubServer(
    t,
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    auth,
  );
  const owner = "gh-allowlist";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "Check owner/secret" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(ghCalls.length, 0, "allowlist rejection happens before spawning gh");
});

test("oversize diffs are clipped before entering model context", async (t) => {
  const bigDiff = `${"diff --git a/f b/f\n".repeat(3000)}${"x".repeat(60000)}`;
  const { runner } = ghFixture(() => ({ stdout: bigDiff }));
  const directory = await mkdtemp(join(tmpdir(), "openfuse-gh-diff-"));
  const auth = new GitHubAuth(
    await createStore(),
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    { adapter: new GitHubAdapter({ enabled: true, allowedRepos: [REPO], runner }) },
  );
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "github_read_pr_diff", arguments: { repo: REPO, number: 7 } },
    { name: "finish_task", arguments: { summary: "Diff reviewed." } },
  ];
  const server = await githubServer(
    t,
    baseConfig(directory, { githubEnabled: true, githubAllowedRepos: [REPO] }),
    auth,
  );
  const owner = "gh-diff";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "Review the diff of PR 7" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  const toolResultTurn = requests.find((request) => request.body.includes("openmuse"));
  assert.ok(
    requests.some((request) => request.body.includes("clipped for context")),
    "the model receives the clipped marker, not the raw 90k diff",
  );
  assert.ok(toolResultTurn === undefined || toolResultTurn.body.length < bigDiff.length);
});
