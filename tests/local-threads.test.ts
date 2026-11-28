import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

// Issue #8: THREADS_BACKEND=local with no CPK_INTELLIGENCE_API_KEY at all.
// Every assertion below runs without a CopilotKit Intelligence key or client.
type ThreadRow = {
  id: string;
  name: string | null;
  archived: boolean;
  agentId: string;
};
let db: Store, directory: string, token: string;
let server: Awaited<ReturnType<typeof createApp>>;
let config: Config;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openfuse-local-threads-"));
  db = await createStore({ dataDir: join(directory, "db") });
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createSession(await createApp(db, config));
});
after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function createSession(server: Awaited<ReturnType<typeof createApp>>) {
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
  return server;
}

test("keyless local mode starts and reports the threads backend", async () => {
  const health = await (await server.app.request("/api/health")).json();
  assert.equal(health.threadsBackend, "local");
  assert.equal(health.ok, true);
  // Restart on the same data directory stays in local mode.
  server = await createSession(await createApp(db, config));
  assert.equal((await (await server.app.request("/api/health")).json()).threadsBackend, "local");
});

test("the main thread provisions locally and stays scoped to its owner", async () => {
  const first = await (await server.app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, true);
  const threadRow = await db.get<ThreadRow>("local-user", "threads", first.threadId);
  assert.ok(threadRow, "the main thread row must exist in the local store");
  assert.equal(threadRow.archived, false);
  assert.equal(threadRow.agentId, "default");
  assert.equal(await db.get("other-user", "threads", first.threadId), null);
  const reopened = await (
    await server.app.request("/api/main-thread", { headers: headers() })
  ).json();
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(reopened.existing, true);
});

test("thread mutations are authenticated, owner-scoped and forged users are ignored", async () => {
  const { threadId } = await (
    await server.app.request("/api/main-thread", { headers: headers() })
  ).json();
  assert.equal((await server.app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  assert.equal(
    (
      await server.app.request(`/api/copilotkit/threads/${threadId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ agentId: "default", name: "Weekend plans" }),
      })
    ).status,
    200,
  );
  let row = await db.get<ThreadRow>("local-user", "threads", threadId);
  assert.ok(row);
  assert.equal(row.name, "Weekend plans");

  // Unarchive is PATCH { archived: false }; archive is the dedicated POST.
  await server.app.request(`/api/copilotkit/threads/${threadId}/archive`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", userId: "forged" }),
  });
  row = await db.get<ThreadRow>("local-user", "threads", threadId);
  assert.ok(row);
  assert.equal(row.archived, true);
  await server.app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", userId: "forged", archived: false }),
  });
  row = await db.get<ThreadRow>("local-user", "threads", threadId);
  assert.ok(row);
  assert.equal(row.archived, false);

  const list = await (
    await server.app.request(
      "/api/copilotkit/threads?agentId=default&includeArchived=true&limit=20&userId=forged",
      { headers: headers() },
    )
  ).json();
  assert.equal(list.nextCursor, null);
  const listed = list.threads.find((thread: { id: string }) => thread.id === threadId);
  assert.ok(listed, "the thread must be listed for its owner");
  assert.equal(listed.name, "Weekend plans");
  // Owner scoping is proven at the store level: a different owner has no row.
  assert.equal(await db.get<ThreadRow>("other-user", "threads", threadId), null);

  // Unknown thread ids read as 404, not 500.
  assert.equal(
    (
      await server.app.request("/api/copilotkit/threads/missing-thread", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ agentId: "default", name: "x" }),
      })
    ).status,
    404,
  );
});

test("/info advertises the local thread mutations the client guards on", async () => {
  const info = await (
    await server.app.request("/api/copilotkit/info", { headers: headers() })
  ).json();
  assert.deepEqual(info.threadEndpoints, {
    list: true,
    inspect: true,
    mutations: true,
    realtimeMetadata: false,
  });
});

test("threads/clear is denied instead of wiping another owner's data", async () => {
  const response = await server.app.request("/api/copilotkit/threads/clear", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.equal(response.status, 405);
});

test("runs journal events locally and connect replays them across a restart", async () => {
  const { threadId } = await (
    await server.app.request("/api/main-thread", { headers: headers() })
  ).json();
  const runBody = {
    threadId,
    runId: crypto.randomUUID(),
    messages: [
      { id: "user-1", role: "user", content: "Plan the week" },
      { id: "assistant-1", role: "assistant", content: "" },
    ],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const run = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(runBody),
  });
  assert.equal(run.status, 200, await run.clone().text());
  const stream = await run.text();
  assert.match(stream, /TEXT_MESSAGE_CONTENT/);
  // The journal landed in the owner-scoped store.
  const journal = await db.get<{ id: string; events: Array<Record<string, unknown>> }>(
    "local-user",
    "thread-events",
    threadId,
  );
  assert.ok(journal, "the run must be journaled");
  assert.ok(
    journal.events.some(
      (event) =>
        event.type === "RUN_STARTED" &&
        Array.isArray((event.input as Record<string, unknown> | undefined)?.messages),
    ),
    "RUN_STARTED must carry the input messages for replay",
  );

  // Full process restart: a brand new app replays history through connect.
  server = await createSession(await createApp(db, config));
  const connect = await server.app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...runBody, runId: crypto.randomUUID() }),
  });
  assert.equal(connect.status, 200, await connect.clone().text());
  const replay = await connect.text();
  assert.match(replay, /Plan the week/);
  assert.match(replay, /TEXT_MESSAGE_CONTENT/);

  // The REST history endpoint folds the same journal.
  const history = await (
    await server.app.request(`/api/copilotkit/threads/${threadId}/messages`, {
      headers: headers(),
    })
  ).json();
  assert.ok(
    (history.messages as Array<{ id: string }>).some((message) => message.id === "user-1"),
    "the user turn must appear in the folded history",
  );

  // The thread row survives the restart and is listed.
  const list = await (
    await server.app.request("/api/copilotkit/threads?agentId=default", {
      headers: headers(),
    })
  ).json();
  assert.ok(
    (list.threads as Array<{ id: string }>).some((thread) => thread.id === threadId),
    "the main thread must be listed after restart",
  );

  // Deleting the thread removes row and journal together.
  const removed = await server.app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ agentId: "default" }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await db.get("local-user", "threads", threadId), null);
  assert.equal(await db.get("local-user", "thread-events", threadId), null);
});

test("egress audit: local mode never contacts CopilotKit Intelligence hosts", async (t) => {
  const originalFetch = globalThis.fetch;
  const hosts: string[] = [];
  const isIntelligenceHost = (hostname: string) =>
    /(^|\.)intelligence\.copilotkit\.ai$/.test(hostname);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    hosts.push(parsed.host);
    if (isIntelligenceHost(parsed.hostname))
      return Promise.reject(new Error(`unexpected egress to ${url}`));
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { threadId } = await (
    await server.app.request("/api/main-thread", { headers: headers() })
  ).json();
  await server.app.request(`/api/copilotkit/threads/${threadId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ agentId: "default", name: "Audit pass" }),
  });
  await server.app.request("/api/copilotkit/threads?agentId=default", { headers: headers() });
  const run = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      messages: [{ id: "user-2", role: "user", content: "Another turn" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  assert.equal(run.status, 200, await run.clone().text());
  await run.text();
  // Scoped per issue #8 acceptance 3: no Intelligence API/realtime requests.
  // (Telemetry is separately opt-out controlled and not an Intelligence
  // egress; see docs/LOCAL-THREADS.md.)
  assert.deepEqual(
    hosts.filter((host) => host.endsWith("intelligence.copilotkit.ai")),
    [],
  );
});
