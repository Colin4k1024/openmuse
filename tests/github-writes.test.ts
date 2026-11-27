import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { GitHubAuth } from "../apps/server/src/github-auth.ts";
import { GitHubExecutor } from "../apps/server/src/github-executor.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { type GhRunner, GitHubError } from "../packages/integrations/src/github.ts";
import { modelFixture } from "./helpers/model.ts";

const REPO = "owner/repo";
const SHA = "a".repeat(40);

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
    githubWriteEnabled: true,
    githubAuthMode: "gh-cli",
    githubAllowedRepos: [REPO],
    ...overrides,
  } as Config;
}

/** Scripted gh: map a predicate on argv to stdout, failing otherwise. */
function ghScript(handler: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push(args);
    const result = handler(args);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: "" };
  };
  return { calls, runner };
}

const userJson = JSON.stringify({ login: "octocat" });
const noPrs = "[]";
const prExistsJson = JSON.stringify([
  { number: 12, url: "https://github.com/owner/repo/pull/12", title: "Fix" },
]);

async function writeServer(
  t: TestContext,
  runner: GhRunner,
  overrides: Partial<Config> = {},
  auth?: (db: Store, cfg: Config) => GitHubAuth,
) {
  const directory = await mkdtemp(join(tmpdir(), "openfuse-ghw-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const cfg = config(directory, overrides);
  const github = auth?.(db, cfg) ?? new GitHubAuth(db, cfg, { runner });
  const server = await createApp(db, cfg, { github });
  const owner = "ghw-owner";
  await server.workspace.ensureSample(owner, server.actions);
  return { db, server, owner, github };
}

const openPr = {
  kind: "github.open_pr" as const,
  data: { repo: REPO, head: "fix/x", base: "main", title: "Fix x", body: "Details." },
};

test("an unapproved proposal performs zero GitHub writes", async (t) => {
  const { calls, runner } = ghScript((args) =>
    args[0] === "api" && args[1] === "user" ? userJson : noPrs,
  );
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, openPr);
  assert.equal(proposal.status, "awaiting_review");
  assert.match(proposal.title, /Open PR in owner\/repo: Fix x/);
  assert.equal(
    calls.filter((args) => args[0] === "pr" && args[1] === "create").length,
    0,
    "no pr create before approval",
  );
  assert.equal(calls.filter((args) => args.includes("POST")).length, 0, "no POST before approval");
});

test("hash mismatch, expiry and double approval cannot execute twice", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list")
      // The second list (post-create lookup) reports the created PR.
      return calls.filter((c) => c[0] === "pr" && c[1] === "create").length ? prExistsJson : noPrs;
    return "";
  });
  const { db, server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, openPr);
  await assert.rejects(server.actions.decide(owner, proposal.id, "tampered-hash", "approve"), {
    status: 409,
  });
  // Force expiry.
  await db.put(owner, "actions", {
    ...proposal,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await assert.rejects(
    server.actions.decide(owner, proposal.id, proposal.hash, "approve"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      return true;
    },
  );
  const expired = await db.get<ActionProposal>(owner, "actions", proposal.id);
  assert.equal(expired?.status, "expired");
  assert.equal(calls.filter((a) => a[1] === "create").length, 0);

  // A fresh proposal approved twice concurrently executes once.
  const second = await server.actions.propose(owner, openPr);
  const [first, raced] = await Promise.all([
    server.actions.decide(owner, second.id, second.hash, "approve"),
    server.actions.decide(owner, second.id, second.hash, "approve"),
  ]);
  const results = [first, raced].map((p) => p.status);
  assert.ok(results.includes("succeeded"));
  assert.equal(
    calls.filter((a) => a[0] === "pr" && a[1] === "create").length,
    1,
    "concurrent approvals execute the write exactly once",
  );
  assert.match(
    first.status === "succeeded" ? (first.result ?? "") : (raced.result ?? ""),
    /Opened PR #12/,
  );
});

test("open_pr returns the existing PR for the same head instead of duplicating", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list") return prExistsJson;
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, openPr);
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /already open/);
  assert.equal(
    calls.filter((a) => a[0] === "pr" && a[1] === "create").length,
    0,
    "lookup-before-create found the existing PR",
  );
});

test("comments carry an idempotency marker; a marker hit skips the POST", async (t) => {
  const { createHash } = await import("node:crypto");
  const body = "LGTM with a note";
  const marker = `<!-- openmuse:idem:${createHash("sha256")
    .update(`github.comment:${REPO}:5:${body}`)
    .digest("hex")
    .slice(0, 16)} -->`;
  const commentsJson = JSON.stringify([
    [
      {
        id: 99,
        body: `old\n\n${marker}`,
        html_url: "https://github.com/owner/repo/issues/5#issuecomment-99",
      },
    ],
  ]);
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "api" && args.includes("--paginate")) return commentsJson;
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, {
    kind: "github.comment",
    data: { repo: REPO, number: 5, body },
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /already posted/);
  assert.equal(
    calls.filter((a) => a.includes("POST") && a.some((x) => x.includes("comments"))).length,
    0,
    "existing marker means no second comment",
  );
});

test("create_branch succeeds when the branch exists at the requested SHA", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "api" && args[1]?.includes("git/ref/heads/"))
      return JSON.stringify({ object: { sha: SHA } });
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, {
    kind: "github.create_branch",
    data: { repo: REPO, branch: "fix/x", fromSha: SHA },
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /already exists/);
  assert.equal(calls.filter((a) => a.includes("POST")).length, 0);
});

test("branch protection refusal fails the proposal with a readable error and no retry", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "api" && args[1]?.includes("/commits?sha=")) return "[]";
    if (args[0] === "api" && args[1]?.includes("git/ref/heads/"))
      return JSON.stringify({ object: { sha: SHA } });
    if (args[0] === "api" && args.includes("POST") && args[3]?.includes("git/trees"))
      return JSON.stringify({ sha: "b".repeat(40) });
    if (args[0] === "api" && args.includes("POST") && args[3]?.includes("git/commits"))
      return JSON.stringify({ sha: "c".repeat(40) });
    if (args[0] === "api" && args.includes("PATCH"))
      return new GitHubError("api", "gh api failed: HTTP 403: Protected branch update failed");
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, {
    kind: "github.commit_files",
    data: {
      repo: REPO,
      branch: "main",
      message: "fix: patch",
      files: [{ path: "a.txt", content: "hello" }],
    },
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "failed");
  assert.match(decided.error ?? "", /403|Protected/i);
  assert.equal(
    calls.filter((a) => a.includes("PATCH")).length,
    1,
    "a definitive 4xx refusal is never retried",
  );
});

test("a racing PR creator (already exists) resolves to the existing PR", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list")
      // First lookup (pre-create) empty; post-race lookup finds the PR.
      return calls.some((c) => c[0] === "pr" && c[1] === "create") ? prExistsJson : noPrs;
    if (args[0] === "pr" && args[1] === "create")
      return new GitHubError(
        "api",
        "gh pr create failed: a pull request for branch fix/x already exists",
      );
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, openPr);
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /already open/);
});

test("every executed write persists an activity receipt", async (t) => {
  const { runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list") return prExistsJson;
    return "";
  });
  const { db, server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, openPr);
  await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  const activity = await db.list<{ status: string; detail: string }>(owner, "activity");
  const receipt = activity.filter((entry) => entry.status === "succeeded");
  assert.ok(receipt.length >= 1, "a succeeded receipt is persisted");
  assert.ok(
    receipt.some((entry) => entry.detail.includes("github.com/owner/repo/pull/12")),
    "receipt carries the PR URL",
  );
});

test("an approved identical commit returns the existing commit (idem trailer)", async (t) => {
  const { createHash } = await import("node:crypto");
  const data = {
    repo: REPO,
    branch: "main",
    message: "fix: patch",
    files: [{ path: "a.txt", content: "hello" }],
  };
  const idemKey = createHash("sha256")
    .update(`github.commit_files:${REPO}:main:${JSON.stringify(data)}`)
    .digest("hex")
    .slice(0, 16);
  const commitsJson = JSON.stringify([
    {
      sha: "d".repeat(40),
      commit: { message: `fix: patch\n\nOpenmuse-Idem: ${idemKey}` },
    },
  ]);
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "api" && args[1]?.includes("git/ref/heads/"))
      return JSON.stringify({ object: { sha: SHA } });
    if (args[0] === "api" && args[1]?.includes("/commits?sha=")) return commitsJson;
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, {
    kind: "github.commit_files",
    data,
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /Commit already on/);
  assert.equal(
    calls.filter((a) => a.includes("POST")).length,
    0,
    "marker hit means no tree/commit writes",
  );
});

test("a 401 mid-execution invalidates the PAT connection and expires pending proposals", async (t) => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const fetchFn = async () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const { runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list") return noPrs;
    if (args[0] === "pr" && args[1] === "create")
      return new GitHubError("auth_failed", "gh pr create failed: HTTP 401: Bad credentials");
    return "";
  });
  const { db, server, owner } = await writeServer(
    t,
    runner,
    { githubAuthMode: "pat", githubWriteEnabled: true, encryptionKey: key },
    (db2, cfg) => new GitHubAuth(db2, cfg, { runner, fetch: fetchFn }),
  );
  const connection = await server.github.connectWithToken(owner, "github_pat_synthetic");
  const proposal = await server.actions.propose(owner, openPr);
  const pending = await server.actions.propose(owner, {
    kind: "github.comment",
    data: { repo: REPO, number: 5, body: "queued" },
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "failed");
  assert.equal(await server.github.connected(owner), false, "401 cleared the connection");
  const stale = await db.get<ActionProposal>(owner, "actions", pending.id);
  assert.equal(stale?.status, "expired", "pending proposals bound to the connection expire");
  assert.ok(connection.id);
});

test("writes are rejected when GITHUB_WRITE_ENABLED=false", async (t) => {
  const { calls, runner } = ghScript(() => userJson);
  const { server, owner } = await writeServer(t, runner, { githubWriteEnabled: false });
  const executor = new GitHubExecutor(server.github);
  await assert.rejects(executor.execute(owner, openPr), { code: "disabled" });
  assert.equal(calls.filter((a) => a.includes("POST")).length, 0);
});

test("branch names with URL-breaking characters cannot be proposed", async (t) => {
  const { server, owner } = await writeServer(t, async () => ({ stdout: userJson, stderr: "" }));
  for (const branch of ["feat#x", "a&b", "q?z", "plus+one"])
    await assert.rejects(
      server.actions.propose(owner, {
        kind: "github.create_branch",
        data: { repo: REPO, branch, fromSha: SHA },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
      },
    );
});

test("findCommitByMarker encodes the branch in the query", async (t) => {
  const { GitHubAdapter } = await import("../packages/integrations/src/github.ts");
  const { calls, runner } = ghScript(() => "[]");
  const adapter = new GitHubAdapter({
    enabled: true,
    writeEnabled: true,
    allowedRepos: [REPO],
    runner,
  });
  await adapter.findCommitByMarker(REPO, "release/v2", "Openmuse-Idem: x");
  const api = calls.find((args) => args[0] === "api");
  assert.ok(api?.[1]?.includes("sha=release%2Fv2"), api?.[1]);
});

test("a commit to a missing branch fails with a clean not_found", async (t) => {
  const { runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "api" && args[1]?.includes("git/ref/heads/"))
      return new GitHubError("not_found", "gh api failed: 404 Not Found");
    return "";
  });
  const { server, owner } = await writeServer(t, runner);
  const proposal = await server.actions.propose(owner, {
    kind: "github.commit_files",
    data: { repo: REPO, branch: "missing", message: "m", files: [{ path: "a", content: "b" }] },
  });
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "failed");
  assert.match(decided.error ?? "", /does not exist/);
});

test("an oversized commit payload is rejected with a readable 422", async (t) => {
  const { server, owner } = await writeServer(t, async () => ({ stdout: userJson, stderr: "" }));
  const executor = new GitHubExecutor(server.github);
  // 20 x 45k chars of 3-byte characters: valid per schema (<=100k chars/file),
  // but 2.7MB in UTF-8 bytes — beyond the ~800KB transport cap.
  const big = "\u4e2d".repeat(45_000);
  await assert.rejects(
    executor.execute(owner, {
      kind: "github.commit_files",
      data: {
        repo: REPO,
        branch: "main",
        message: "m",
        files: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt`, content: big })),
      },
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 422);
      assert.match((error as Error).message, /smaller commits/);
      return true;
    },
  );
});

test("end to end: model prepare tool pauses for review, approval resumes the task", async (t) => {
  const { calls, runner } = ghScript((args) => {
    if (args[0] === "api" && args[1] === "user") return userJson;
    if (args[0] === "pr" && args[1] === "list")
      return calls.some((c) => c[0] === "pr" && c[1] === "create") ? prExistsJson : noPrs;
    return "";
  });
  const directory = await mkdtemp(join(tmpdir(), "openfuse-ghw-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const cfg = config(directory, { agentBackend: "model", model: "openai/fixture" });
  const github = new GitHubAuth(db, cfg, { runner });
  await modelFixture(t, (index) => calls2[index]);
  const calls2 = [
    {
      name: "github_prepare_pr",
      arguments: { repo: REPO, head: "fix/x", base: "main", title: "Fix x", body: "Details." },
    },
    { name: "finish_task", arguments: { summary: "PR prepared and opened after review." } },
  ];
  const server = await createApp(db, cfg, { github });
  const owner = "ghw-e2e";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "Open the fix PR" });
  await server.agent.worker.tick();
  let current = await server.agent.getTask(owner, task.id);
  assert.equal(current.status, "waiting_approval");
  assert.equal(calls.filter((a) => a[0] === "pr" && a[1] === "create").length, 0);

  const proposal = (await db.list<ActionProposal>(owner, "actions")).find(
    (p) => p.taskId === task.id,
  );
  assert.ok(proposal);
  const decided = await server.actions.decide(owner, proposal.id, proposal.hash, "approve");
  assert.equal(decided.status, "succeeded");
  assert.match(decided.result ?? "", /Opened PR #12/);

  await server.agent.worker.tick();
  current = await server.agent.getTask(owner, task.id);
  assert.equal(current.status, "succeeded", current.error ?? current.question);
  assert.equal(calls.filter((a) => a[0] === "pr" && a[1] === "create").length, 1);
});
