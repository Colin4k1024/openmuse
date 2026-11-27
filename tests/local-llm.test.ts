import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { modelFixture } from "./helpers/model.ts";

/**
 * Local-LLM pathway verification (Issue #7). The fixture server is a loopback
 * OpenAI-compatible endpoint — the same protocol Ollama/vLLM/LM Studio serve —
 * reached through OPENAI_BASE_URL with a provider-prefixed MODEL id.
 */

function config(directory: string): Parameters<typeof createApp>[1] {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/local-model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  } as Config;
}

test("a loopback OpenAI-compatible endpoint drives the full task loop with tool calls", async (t) => {
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const calls = [
    { name: "set_plan", arguments: { steps: ["Look around", "Report"] } },
    { name: "finish_task", arguments: { summary: "Local endpoint works." } },
  ];
  assert.ok(
    process.env.OPENAI_BASE_URL?.startsWith("http://127.0.0.1:"),
    "fixture served the model on loopback via OPENAI_BASE_URL",
  );
  const directory = await mkdtemp(join(tmpdir(), "openfuse-local-llm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const server = await createApp(db, config(directory));
  const owner = "local-llm";
  await server.workspace.ensureSample(owner, server.actions);
  const task = await server.agent.createTask(owner, { prompt: "Prove the local model works" });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask(owner, task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(finished.result, "Local endpoint works.");
  assert.deepEqual(
    finished.plan.map((step) => step.title),
    ["Look around", "Report"],
    "the local endpoint's tool call set the plan",
  );
  assert.ok(
    requests.every((request) => request.path.startsWith("/v1/")),
    "every request went to the OPENAI_BASE_URL gateway",
  );
});

test("an unreachable local endpoint fails the task with a readable, retryable error", async (t) => {
  const base = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1"; // nothing listens here
  const directory = await mkdtemp(join(tmpdir(), "openfuse-local-down-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  try {
    const server = await createApp(db, config(directory));
    const owner = "local-down";
    await server.workspace.ensureSample(owner, server.actions);
    const task = await server.agent.createTask(owner, { prompt: "Try the model" });
    await server.agent.worker.tick();
    const saved = await server.agent.getTask(owner, task.id);
    assert.equal(saved.status, "failed");
    assert.ok(saved.error && saved.error.length > 0, "an error message is recorded");
    // The task is retryable: a recovered endpoint can continue the work.
    const retried = await server.agent.control(owner, task.id, "retry");
    assert.equal(retried.status, "queued");
  } finally {
    if (base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = base;
  }
});
