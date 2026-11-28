# Local thread storage (`THREADS_BACKEND=local`)

Conversation threads can persist entirely on this host — no CopilotKit
Intelligence account, no cloud. The decision record is
[ADR 0002](adr/0002-local-thread-storage.md); this page is the operational
contract.

## Configuration

| Setting | Effect |
|---|---|
| `THREADS_BACKEND` unset + `CPK_INTELLIGENCE_API_KEY` present | `intelligence` (existing installs unchanged) |
| `THREADS_BACKEND` unset + no key | `local` — starts keyless |
| `THREADS_BACKEND=local` | local store; a present key is ignored |
| `THREADS_BACKEND=intelligence` | requires the key (boot error without it) |

`GET /api/health` reports the resolved backend in `threadsBackend`; the mobile
Settings screen shows "Local storage" vs "CopilotKit Intelligence" accordingly.

## What runs where

- The CopilotKit runtime runs in **SSE mode**: agents execute in-process; run
  replies stream as SSE exactly as before.
- A `DurableThreadRunner` journals each run's compacted AG-UI events (including
  your sent messages — the SDK embeds the run input in `RUN_STARTED`) to the
  install's own store (PGlite by default, Postgres with `DATABASE_URL`) as
  owner-scoped `threads` and `thread-events` records.
- The thread REST surface (`GET/PATCH/DELETE /api/copilotkit/threads...`) is
  served from that store, scoped to the signed-in owner; a forged `userId` is
  ignored. `POST threads/clear` is denied (405).
- Thread replay uses the same path as before: opening a thread calls
  `connectAgent`, which replays the journal — including after a full server
  restart on the same data directory.
- `GET /threads/:id/messages` folds the journal into a message list (contract
  parity; the app hydrates via replay, not this endpoint).

## Egress posture

With `THREADS_BACKEND=local` the thread system makes **no** requests to
`api.intelligence.copilotkit.ai` or `realtime.intelligence.copilotkit.ai`; this
is asserted by `tests/local-threads.test.ts`. Product telemetry
(`telemetry.copilotkit.ai`, opt-out via `DO_NOT_TRACK=1`) is a separate,
pre-existing sink and unrelated to thread storage.

## Limits

- No migration of existing cloud threads: switching a keyed install to `local`
  starts a fresh local history.
- No realtime thread-metadata sync (the list refreshes on app interaction).
- The per-thread event journal has no retention cap in this version.
- A reply interrupted by a server crash loses that run's journal write
  (completed runs persist); the partial reply is still streamed to the app.

## Testing

`tests/local-threads.test.ts` covers: keyless startup, owner scoping and
forged-user rejection, rename/archive/unarchive/list/delete, `/info` mutation
advertising, `threads/clear` denial, journal + replay across a full `createApp`
restart, and the Intelligence-host egress audit. Intelligence-mode behavior is
pinned by the existing `tests/rich-threads.test.ts` and `tests/agent-api.test.ts`.

## Rollback

Set `THREADS_BACKEND=intelligence` (or unset it with the key present) and
restart: the runtime returns to CopilotKit Intelligence exactly as before. Local
records remain in the store, inert.
