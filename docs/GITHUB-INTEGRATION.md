# GitHub integration boundary

Status: proposed contract, tracked by [Epic #9](https://github.com/Colin4k1024/openmuse/issues/9). This document freezes the data boundary, permission model, and task-state interactions for the privacy-first GitHub digital employee before runtime code lands. Companion decision record: [ADR 0001](adr/0001-github-integration.md). Design source: [github-digital-employee.md](plans/github-digital-employee.md).

## Data boundary

The deployment is single-owner and self-hosted. Under the default configuration the GitHub integration opens exactly one egress point: `api.github.com` (or a configured GitHub Enterprise host). All other data stays on the host:

- Code is read and written through the local `gh` CLI and local git; no code is sent to any third party other than GitHub itself.
- Credentials are stored only as AES-256-GCM envelopes via [vault.ts](../packages/integrations/src/vault.ts) under `TOKEN_ENCRYPTION_KEY`.
- LLM inference is expected to use a local OpenAI-compatible endpoint (`OPENAI_BASE_URL`, [tanstack-agent.ts](../apps/server/src/engine/tanstack-agent.ts)); when a cloud provider is configured instead, the operator accepts that prompts containing repository excerpts leave the host. This choice is explicit configuration, not a default.
- Conversation persistence is local once `THREADS_BACKEND=local` ships ([#8](https://github.com/Colin4k1024/openmuse/issues/8)); until then the CopilotKit Intelligence requirement of [config.ts](../apps/server/src/config.ts) is unchanged.

## Proposed OpenMuse configuration

These are proposed **OpenMuse** settings, not upstream environment variables:

```dotenv
GITHUB_ENABLED=false              # master switch; read tools register only when true
GITHUB_WRITE_ENABLED=false        # write tools register only when true; independent of read
GITHUB_AUTH_MODE=gh-cli           # gh-cli | pat
GITHUB_ALLOWED_REPOS=             # comma-separated owner/repo list; empty = deny all
GITHUB_API_HOST=                  # optional GitHub Enterprise host; default api.github.com
```

Disabled, misconfigured, or unauthenticated must report unavailable, never simulate a successful read or write. An empty `GITHUB_ALLOWED_REPOS` denies every repository operation, including reads.

## Adapter boundary

A new `packages/integrations/src/github.ts` owns all GitHub access. Phase 1 wraps the `gh` CLI with `--json` structured output and zod response validation, following the adapter style of [google.ts](../packages/integrations/src/google.ts). The CLI keeps credential custody in `gh auth`; the adapter never reads, logs, or forwards tokens, and sanitizes stderr before surfacing errors.

Errors must stay distinguishable so the task engine can route them:

| Condition | Detection | Task behavior |
| --- | --- | --- |
| `gh` not installed | spawn ENOENT | Task → `waiting_input` with setup guidance |
| Not authenticated | `gh auth status` failure | Task → `waiting_input` |
| Token revoked / PAT mode 401 | API response | Invalidate connection; pending proposals expire |
| Rate limited | 403/429 with `Retry-After` | Failure backoff, no immediate retry |
| No repo access | 404 | Task → `failed` with readable reason |
| Branch protection refusal | 403 on push | Task → `failed`, receipt preserved |

Repository allowlisting is enforced **before** spawning any subprocess: a request for a non-allowlisted `owner/repo` is rejected in-process.

## Approval matrix

Every external write becomes a durable proposal in ActionService ([actions.ts](../apps/server/src/actions.ts)) and executes only after human approval. Proposals are hash-bound to their exact payload; mutation invalidates them with 409, and expiry invalidates them with 409.

| Write operation | Proposal kind | Hash-bound payload | Post-approval receipt |
| --- | --- | --- | --- |
| Create branch | `github_create_branch` | repo, base SHA, branch name | branch ref |
| Commit files | `github_commit_files` | repo, branch, file list, full contents, message | commit SHA |
| Open pull request | `github_open_pr` | repo, head, base, title, full body, diff summary | PR number + URL |
| Comment (issue/PR) | `github_comment` | repo, target number, full body | comment URL |

Never approvable through this integration: merge, close, release, force-push, branch deletion, permission changes. These remain human-only in the GitHub UI.

## Idempotency and crash recovery

No hidden retry occurs after an uncertain external write, matching the existing README guarantee. Recovery rules:

- `open_pull_request` first queries for an existing PR from the same head branch; an existing PR is returned as the result instead of creating a duplicate.
- Comments carry an `<!-- openmuse:idem:<sha256> -->` marker; before posting, the latest comments are scanned for the marker.
- If the process crashes after approval but before the outcome is recorded, recovery performs the lookup first. An ambiguous outcome routes to the human rather than retrying.
- The model-task tool layer already provides a serial tool queue and an `operations` sha256 cache ([model.ts](../apps/server/src/engine/model.ts)); GitHub tools use it so replays after checkpoint loss do not repeat external calls.

## Task state machine invariants

The integration must preserve the invariants of [worker.ts](../apps/server/src/engine/worker.ts) and [actions.ts](../apps/server/src/actions.ts):

1. A task in `waiting_approval` is claimable only for proposal-expiry checks, never for execution.
2. A write proposal moves `awaiting_review → executing → succeeded|failed`; it never returns to `awaiting_review` (regression class of upstream CopilotKit/OpenMuse#36).
3. Approving a stale-hash or expired proposal fails with 409 and produces no external request.
4. Token invalidation expires all connection-bound `awaiting_review` proposals and moves their tasks to `waiting_input`.
5. A task reaching a terminal status (`succeeded`, `failed`, `cancelled`) produces no further external requests, including after lease loss (`LostLeaseError`).

## Evidence and audit

GitHub-sourced facts appear as evidence with kind `"github"` (additive extension of the `Evidence` union in [packages/domain/src/agent.ts](../packages/domain/src/agent.ts)) carrying repo, number, URL, and an excerpt. Every executed write persists a receipt as a `RunEvent` (kind `result`) plus the task result. Database contents must never contain plaintext tokens; tests assert the absence of `github_pat_`/`ghp_` prefixes in stored values.

## Verification

Contract tests run against a fake `gh` binary that records argv and replays canned stdout/stderr/exit codes, following the patterns of [tests/helpers](../tests/helpers) and the provider-contract tests (`tests/google.test.ts`, `tests/openbot.test.ts`). No test may reach the real GitHub API. External side effects are verified by asserting recorded argv/request snapshots: read flows must show zero write invocations, and unapproved proposals must show zero write invocations.

## Out of scope

GitHub App distribution, multi-account support, token rotation, GitLab/Gitea implementations (interface shape may anticipate them), automatic merges/closes/releases, device push, and any change to the OpenBot adapter.
