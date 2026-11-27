# ADR 0001: GitHub integration for a privacy-first digital employee

- Status: proposed (accept on merge of the tracking PR)
- Date: 2026-11-27
- Tracking: [Epic #9](https://github.com/Colin4k1024/openmuse/issues/9), contract in [docs/GITHUB-INTEGRATION.md](../GITHUB-INTEGRATION.md)

## Context

The owner wants OpenMuse to take over daily GitHub development work (PR triage, issue handling, CI follow-up, drafting reviews and fix PRs) while code, credentials, and conversation data remain on the host. The repository today has no GitHub adapter (`packages/integrations/` contains only google/pdf/vault), a mandatory human-review path for external writes ([actions.ts](../../apps/server/src/actions.ts)), a durable task worker with SQL leases ([worker.ts](../../apps/server/src/engine/worker.ts)), and an existing local-LLM egress (`OPENAI_BASE_URL`).

## Decisions

### D1: Wrap the `gh` CLI in phase 1, behind an adapter interface

**Decision.** `packages/integrations/src/github.ts` shells out to `gh` with `--json` output and validates responses with zod. An Octokit (direct REST/GraphQL) implementation may later sit behind the same interface.

**Rationale.** Credential custody stays in `gh auth`, which already handles secure storage on the developer's machine; subprocess argv gives a natural audit log for tests; the repo's contract-test style (fake binaries, recorded argv) fits.

**Rejected alternative.** Octokit as the phase-1 transport: it would require the adapter to manage PAT material immediately and offers no capability the read-only phase needs. Not rejected forever — the interface must not leak `gh`-isms.

### D2: fine-grained PAT for API-mode writes, not a GitHub App

**Decision.** PAT mode stores a fine-grained personal access token, encrypted with the existing AES-256-GCM envelope ([vault.ts](../../packages/integrations/src/vault.ts)), scoped per-repository with minimum permissions and a short expiry.

**Rationale.** The deployment is single-owner and self-hosted; a GitHub App is distribution machinery for multi-tenant installs and adds webhook and key-management surface for no benefit here.

**Rejected alternatives.** GitHub App (unnecessary complexity, broader blast radius); classic PAT (cannot scope per-repository); OAuth web flow (no token-rotation story, and PAT needs no flow).

### D3: every external write passes through ActionService review

**Decision.** Create branch, commit, open PR, and comment each become a durable proposal hash-bound to their full payload. Approval is human, per action, and re-checked against connection validity at approval time.

**Rationale.** The infrastructure already exists with the exact semantics needed (stale-hash 409, expiry 409, connection checks) and the README already guarantees no hidden retry after uncertain external writes.

**Rejected alternative.** "Trusted" auto-approval for low-risk writes: it creates an unaudited escalation path and violates the project's human-in-the-loop posture.

### D4: repository allowlist with default deny

**Decision.** `GITHUB_ALLOWED_REPOS` is an explicit list; empty means deny everything, including reads. The check runs before any subprocess spawn.

**Rationale.** The agent's blast radius should be enumerable from configuration alone.

### D5: idempotency by lookup-before-create, never blind retry

**Decision.** PR creation looks up existing PRs by head branch; comments carry `<!-- openmuse:idem:<sha256> -->` markers; post-crash recovery performs the lookup first and routes ambiguous outcomes to the human.

**Rationale.** GitHub's API is not idempotent; duplicate PRs and comments are user-visible damage. Combined with the `operations` cache in [model.ts](../../apps/server/src/engine/model.ts), replays stay side-effect free.

**Rejected alternative.** Client-generated idempotency keys only: GitHub does not honor them; markers and lookups are observable and testable.

### D6: local LLM is the supported inference path for this initiative

**Decision.** Validation work ([#7](https://github.com/Colin4k1024/openmuse/issues/7)) treats `OPENAI_BASE_URL`-targeted local serving (Ollama/vLLM-class) as the supported configuration and documents a model admission bar based on tool-calling reliability.

**Rationale.** Repository content enters prompts; with a local endpoint the code boundary of this initiative holds end to end. Cloud providers remain a conscious operator choice, not a requirement.

## Consequences

- Positive: credential custody, audit, and review semantics reuse battle-tested in-repo mechanisms; every write is individually approvable and reversible by the human on GitHub.
- Negative: `gh` CLI availability becomes a runtime dependency for phase 1; PAT expiry requires operator attention; comment idem markers are visible in comment source.
- Follow-ups: Octokit transport behind the same interface; GitHub Enterprise host verification; upstream tracking of CopilotKit/OpenMuse#73 and #179 for local thread storage ([#8](https://github.com/Colin4k1024/openmuse/issues/8)).
