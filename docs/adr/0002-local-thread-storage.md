# ADR 0002: Local thread storage without CopilotKit Intelligence

- Status: proposed (accept on merge of the tracking PR)
- Date: 2026-11-28
- Tracking: [Issue #8](https://github.com/Colin4k1024/openmuse/issues/8), [Epic #9](https://github.com/Colin4k1024/openmuse/issues/9), operational detail in [docs/LOCAL-THREADS.md](../LOCAL-THREADS.md)

## Context

`config.ts` required `CPK_INTELLIGENCE_API_KEY` in every mode, and thread persistence
lived in CopilotKit Intelligence (a cloud service at `api.intelligence.copilotkit.ai`
/ `wss://realtime.intelligence.copilotkit.ai`). That contradicts this fork's privacy
goal — conversations must not leave the host. The mobile app's Rich Threads surface
(list, rename, archive, unarchive, replay) is the only thread consumer in this fork.
Upstream has two open issues requesting the same capability:
[OpenMuse#73](https://github.com/CopilotKit/OpenMuse/issues/73) (make Intelligence
optional) and [OpenMuse#179](https://github.com/CopilotKit/OpenMuse/issues/179) (a
working keyless local thread store, still unmerged upstream).

## Decisions

### D1: SSE runtime with a durable custom runner, not a fake Intelligence client

**Decision.** In local mode the CopilotKit runtime is constructed **without**
`intelligence`, which selects SSE mode: agents run in-process through an
`InMemoryAgentRunner`. A `DurableThreadRunner` wraps that inner runner, mirrors its
compacted AG-UI event journal (run input messages included — the SDK injects them
into `RUN_STARTED`) into the owner-scoped store, and replays it from the store on
`connect()` so `copilotkit.connectAgent` works across full process restarts.

**Rationale.** Passing `intelligence` flips the *entire* runtime into platform mode:
runs execute on CopilotKit's infrastructure over a WebSocket runner protocol
(`IntelligenceAgentRunner`, `runtime.mjs`). No duck-typed local object can satisfy
that protocol, so the issue's original sketch ("abstract the CopilotKitIntelligence
injection point, implement it with PGlite") is not implementable as written. The
runner extension point (`CopilotSseRuntime` accepts `options.runner`) is the
supported seam.

**Rejected alternative.** Upstream #179's full standalone runner (persistent
`AgentRunner` with its own run/connect journaling per reply, Postgres lock recovery,
`/api/copilotkit/threads*` fully re-hosted): correct but a much larger fork surface
than this issue needs; revisit if upstream merges it.

### D2: thread REST served by Hono-layer hooks, owner-scoped

**Decision.** `createCopilotHonoHandler({ hooks })` intercepts the thread REST
routes (`threads/list|update|archive|messages|events|state|clear`) in
`onBeforeHandler` and serves them from the local store; `/info`'s
`threadEndpoints` is rewritten in `onResponse` so the client enables thread
mutations. The authenticated owner is captured in an `AsyncLocalStorage` around
every `runtime.fetch` call; a forged `userId` in query or body is ignored.

**Rationale.** The runtime's own SSE thread endpoints read a process-global,
owner-unaware store (and `threads/clear` would wipe every owner's data), so they
must not serve production traffic; the hooks API is the SDK's sanctioned
interception point ("throw a Response to short-circuit").

**Rejected alternative.** Hand-rolled path matching inside `app.all` — duplicates
the router and misses the `/info` rewrite the client's mutation guard depends on.

### D3: `THREADS_BACKEND` with conservative auto-resolution

**Decision.** `THREADS_BACKEND=intelligence|local`; unset resolves to
`intelligence` when `CPK_INTELLIGENCE_API_KEY` is present, otherwise `local`.
Explicit `intelligence` still requires the key (same error message); explicit
`local` never needs one.

**Rationale.** Existing keyed installs keep today's behavior byte-for-byte, and
keyless installs (which previously failed to boot) come up fully local. This
satisfies issue #8's "CPK key becomes optional" without changing what working
deployments do. The switch itself is the issue's designed rollback.

### D4: additive records on the existing store

**Decision.** Threads persist as two new record kinds on the existing `Store`
(PGlite or Postgres): `threads` (summary rows) and `thread-events` (the compacted
journal). No schema change to existing kinds; message history for the REST
endpoint is folded from events, not stored twice.

**Rationale.** Reuses the install's single durable substrate; DB changes stay
additive per the epic's constraints.

## Relationship to upstream

This is a fork-level implementation of what upstream #73 asks for and what #179
implements more completely. Track both; if either merges upstream, prefer the
upstream path and retire this module (the `THREADS_BACKEND` switch keeps the
migration a config change). Not intended as a permanent divergence.

## Consequences

- No cloud thread migration: keyed installs that switch to `local` start with an
  empty local history (cloud threads remain in the Intelligence project).
- Realtime thread-metadata sync (`threads/subscribe`) is not offered in local
  mode — the client only calls it when `/info` advertises a realtime plane, which
  local mode never does.
- The event journal is append-only and unbounded per thread in this first cut;
  no retention policy yet. The in-process snapshot it is sourced from is bounded
  (1000 threads / 100 runs / 512 MB), so once those bounds are exceeded new
  events stop being appended until restart rather than history being lost.
- Crash mid-reply loses that run's journal write (persistence happens when the
  stream settles); completed runs survive restarts.
- Telemetry is unaffected and remains separately opt-out controlled
  (`DO_NOT_TRACK`); it is not an Intelligence-thread egress.
