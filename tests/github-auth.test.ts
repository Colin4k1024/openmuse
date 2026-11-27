import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { GitHubAuth } from "../apps/server/src/github-auth.ts";
import { GitHubAdapter } from "../packages/integrations/src/github.ts";

const KEY = randomBytes(32).toString("base64");
const TOKEN = "github_pat_11ABCDEFG_synthetic";

function config(overrides: Partial<Config> = {}): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: ".openfuse-test",
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: KEY,
    githubEnabled: true,
    githubAuthMode: "pat",
    githubAllowedRepos: ["owner/repo"],
    githubApiHost: "https://api.github.com",
    ...overrides,
  } as Config;
}

function patFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push(req);
      return handler(req);
    },
  };
}

const okUser = (login = "octocat", scopes = "repo, read:org") =>
  new Response(JSON.stringify({ login }), {
    status: 200,
    headers: { "content-type": "application/json", "x-oauth-scopes": scopes },
  });

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

test("disabled integration has no connection and cannot connect", async () => {
  const auth = new GitHubAuth(db, config({ githubEnabled: false }));
  assert.equal(auth.configured(), false);
  assert.equal(await auth.connection("u-off"), null);
  assert.equal(await auth.connected("u-off"), false);
  await assert.rejects(auth.connectWithToken("u-off", TOKEN), { status: 409 });
});

test("connectWithToken validates with GitHub and stores only ciphertext", async () => {
  const { calls, fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  const connection = await auth.connectWithToken("u-pat", TOKEN);
  assert.equal(connection.account, "octocat");
  assert.deepEqual(connection.scopes, ["repo", "read:org"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(new URL(calls[0].url).origin, "https://api.github.com");

  const stored = await db.get<{ secret: string }>("u-pat", "credentials", "github");
  assert.ok(stored?.secret.startsWith("v1."), "secret must be a vault envelope");
  assert.ok(stored !== null);
  assert.equal(stored.secret.includes(TOKEN), false);
  assert.equal(JSON.stringify(stored).match(/github_pat_|ghp_/), null);

  const read = await auth.connection("u-pat");
  assert.equal(read?.account, "octocat");
  assert.equal(read?.mode, "pat");
  assert.equal(await auth.connected("u-pat"), true);
});

test("connectWithToken stores nothing when GitHub rejects the token", async () => {
  const { fetch } = patFetch(() => new Response("bad credentials", { status: 401 }));
  const auth = new GitHubAuth(db, config(), { fetch });
  await assert.rejects(auth.connectWithToken("u-bad", TOKEN), { status: 401 });
  assert.equal(await db.get("u-bad", "credentials", "github"), null);
  assert.equal(await auth.connected("u-bad"), false);
});

test("tampered ciphertext and wrong keys fail closed with a diagnosable 503", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  await auth.connectWithToken("u-tamper", TOKEN);

  // Valid envelope lengths (12B nonce, 16B tag) so the AES-GCM auth path is
  // what actually rejects the tampering, not the length pre-check.
  await db.put("u-tamper", "credentials", {
    id: "github",
    connectionId: "x",
    secret: `v1.${"A".repeat(16)}.${"A".repeat(22)}.QUJD`,
  });
  await assert.rejects(auth.connection("u-tamper"), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /TOKEN_ENCRYPTION_KEY|decrypt/i);
    assert.equal(message.includes(TOKEN), false, "error must not leak plaintext");
    return true;
  });

  const wrongKey = new GitHubAuth(
    db,
    config({ encryptionKey: randomBytes(32).toString("base64") }),
    {
      fetch,
    },
  );
  await auth.connectWithToken("u-wrongkey", TOKEN);
  await assert.rejects(wrongKey.connection("u-wrongkey"), { status: 503 });
});

test("a 401 during validation invalidates the connection and expires bound proposals", async () => {
  let status = 200;
  const { fetch } = patFetch(() =>
    status === 200 ? okUser() : new Response("revoked", { status: 401 }),
  );
  const auth = new GitHubAuth(db, config(), { fetch });
  const connection = await auth.connectWithToken("u-inv", TOKEN);

  // A proposal bound to this connection, plus an unrelated one.
  await db.put("u-inv", "actions", {
    id: "a-bound",
    kind: "github.comment",
    status: "awaiting_review",
    connectionId: connection.id,
    taskId: "t-1",
  });
  await db.put("u-inv", "actions", {
    id: "a-other",
    kind: "github.comment",
    status: "awaiting_review",
    connectionId: "someone-else",
  });
  await db.put("u-inv", "actions", {
    id: "a-done",
    kind: "github.comment",
    status: "succeeded",
    connectionId: connection.id,
  });
  await db.put("u-inv", "tasks", { id: "t-1", status: "waiting_approval" });

  status = 401;
  const after401 = await auth.validate("u-inv");
  assert.equal(after401, null);
  assert.equal(await auth.connected("u-inv"), false);

  const bound = await db.get<{ status: string }>("u-inv", "actions", "a-bound");
  assert.equal(bound?.status, "expired");
  const task = await db.get<{ status: string; question?: string }>("u-inv", "tasks", "t-1");
  assert.equal(task?.status, "waiting_input");
  assert.match(task?.question ?? "", /GitHub/);
  // Unrelated and finished proposals are untouched.
  assert.equal(
    (await db.get<{ status: string }>("u-inv", "actions", "a-other"))?.status,
    "awaiting_review",
  );
  assert.equal(
    (await db.get<{ status: string }>("u-inv", "actions", "a-done"))?.status,
    "succeeded",
  );
});

test("disconnect clears the credential and expires its pending proposals", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  const connection = await auth.connectWithToken("u-disc", TOKEN);
  await db.put("u-disc", "actions", {
    id: "a-pending",
    kind: "github.open_pr",
    status: "awaiting_review",
    connectionId: connection.id,
  });
  await auth.disconnect("u-disc");
  assert.equal(await auth.connected("u-disc"), false);
  assert.equal(
    (await db.get<{ status: string }>("u-disc", "actions", "a-pending"))?.status,
    "expired",
  );
});

test("connection() never carries the decrypted token at runtime", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  await auth.connectWithToken("u-clean", TOKEN);
  const connection = await auth.connection("u-clean");
  assert.ok(connection);
  assert.equal("token" in connection, false);
  assert.equal(JSON.stringify(connection).includes(TOKEN), false);
});

test("reconnecting expires the previous connection's pending proposals", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  const first = await auth.connectWithToken("u-re", TOKEN);
  await db.put("u-re", "actions", {
    id: "a-old",
    kind: "github.comment",
    status: "awaiting_review",
    connectionId: first.id,
  });
  const second = await auth.connectWithToken("u-re", `${TOKEN}-rotated`);
  assert.notEqual(first.id, second.id);
  assert.equal((await db.get<{ status: string }>("u-re", "actions", "a-old"))?.status, "expired");
  assert.equal((await auth.connection("u-re"))?.id, second.id);
});

test("concurrent connects leave exactly one stored connection", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  const [a, b] = await Promise.all([
    auth.connectWithToken("u-race", TOKEN),
    auth.connectWithToken("u-race", `${TOKEN}-b`),
  ]);
  const final = await auth.connection("u-race");
  assert.ok(final);
  assert.ok(
    final.id === a.id || final.id === b.id,
    "the stored connection is one of the two contenders",
  );
});

test("status probe degrades to unavailable (not 500) when GitHub is unreachable", async () => {
  let down = false;
  const { fetch } = patFetch(() => {
    if (down) throw new TypeError("fetch failed: ECONNREFUSED");
    return okUser();
  });
  const auth = new GitHubAuth(db, config(), { fetch });
  await auth.connectWithToken("u-down", TOKEN);
  down = true;
  const probe = await auth.probe("u-down");
  assert.equal(probe.state, "unavailable");
  if (probe.state === "unavailable") assert.match(probe.detail, /unreachable/);
  // The credential must survive: a network outage is not a revocation.
  assert.equal(await auth.connected("u-down"), true);
});

test("probe surfaces an undecryptable credential as a diagnosable 503, not unavailable", async () => {
  const { fetch } = patFetch(() => okUser());
  const auth = new GitHubAuth(db, config(), { fetch });
  await auth.connectWithToken("u-503", TOKEN);
  const wrongKey = new GitHubAuth(
    db,
    config({ encryptionKey: randomBytes(32).toString("base64") }),
    { fetch },
  );
  await assert.rejects(wrongKey.probe("u-503"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 503);
    assert.match(error.message, /TOKEN_ENCRYPTION_KEY/);
    return true;
  });
});

test("gh-cli probe distinguishes not-installed from not-authenticated", async () => {
  const missing = new GitHubAuth(db, config({ githubAuthMode: "gh-cli" }), {
    adapter: new GitHubAdapter({ enabled: true, allowedRepos: [], ghPath: "/nonexistent/gh" }),
  });
  const probe = await missing.probe("u-probe");
  assert.equal(probe.state, "unavailable");
  if (probe.state === "unavailable") assert.match(probe.detail, /not installed/);
});

test("gh-cli mode derives the connection live and stores nothing", async () => {
  const adapter = new GitHubAdapter({
    enabled: true,
    allowedRepos: ["owner/repo"],
    runner: async (args) => {
      assert.deepEqual(args, ["api", "user"]);
      return { stdout: JSON.stringify({ login: "cli-user" }), stderr: "" };
    },
  });
  const auth = new GitHubAuth(db, config({ githubAuthMode: "gh-cli" }), { adapter });
  const connection = await auth.connection("u-cli");
  assert.equal(connection?.account, "cli-user");
  assert.equal(connection?.mode, "gh-cli");
  assert.equal(await db.get("u-cli", "credentials", "github"), null);

  const broken = new GitHubAuth(db, config({ githubAuthMode: "gh-cli" }), {
    adapter: new GitHubAdapter({
      enabled: true,
      allowedRepos: [],
      runner: async () => {
        throw new Error("not logged in");
      },
    }),
  });
  assert.equal(await broken.connection("u-cli2"), null);
  assert.equal(await broken.connected("u-cli2"), false);
});

test("config parses GitHub settings and enforces mode rules", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      CPK_INTELLIGENCE_API_KEY: "test-key",
      GITHUB_ENABLED: "true",
      GITHUB_WRITE_ENABLED: "true",
      GITHUB_AUTH_MODE: "pat",
      TOKEN_ENCRYPTION_KEY: KEY,
      GITHUB_ALLOWED_REPOS: " a/b , c/d ,",
    });
    const parsed = readConfig();
    assert.equal(parsed.githubEnabled, true);
    assert.equal(parsed.githubWriteEnabled, true);
    assert.equal(parsed.githubAuthMode, "pat");
    assert.deepEqual(parsed.githubAllowedRepos, ["a/b", "c/d"]);
    assert.equal(parsed.githubApiHost, "https://api.github.com");

    process.env.GITHUB_API_HOST = "http://insecure.example";
    assert.throws(() => readConfig(), /GITHUB_API_HOST/);
    process.env.GITHUB_API_HOST = "https://";
    assert.throws(() => readConfig(), /GITHUB_API_HOST/);
    process.env.GITHUB_API_HOST = "https://foo bar";
    assert.throws(() => readConfig(), /GITHUB_API_HOST/);
    process.env.GITHUB_API_HOST = "https://api.github.com/#frag";
    assert.throws(() => readConfig(), /GITHUB_API_HOST/);
    process.env.GITHUB_API_HOST = "";

    process.env.GITHUB_AUTH_MODE = "oauth";
    assert.throws(() => readConfig(), /GITHUB_AUTH_MODE/);
    process.env.GITHUB_AUTH_MODE = "pat";
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => readConfig(), /TOKEN_ENCRYPTION_KEY/);

    process.env.GITHUB_AUTH_MODE = "gh-cli";
    process.env.GITHUB_ENABLED = "false";
    assert.throws(() => readConfig(), /GITHUB_WRITE_ENABLED requires/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
