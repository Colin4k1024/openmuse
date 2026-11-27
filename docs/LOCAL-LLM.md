# Running OpenFuse on a local model

Status: verified pathway, tracked by [Issue #7](https://github.com/Colin4k1024/openmuse/issues/7). The agent loop runs against any OpenAI-compatible endpoint through `OPENAI_BASE_URL` ([tanstack-agent.ts](../apps/server/src/engine/tanstack-agent.ts)); the pathway — including tool calling, retries, and failure handling — is covered by contract tests against a loopback fixture ([tests/local-llm.test.ts](../tests/local-llm.test.ts), [tests/helpers/model.ts](../tests/helpers/model.ts)).

## Configuration

```dotenv
AGENT_BACKEND=model
MODEL=openai/<your-model-id>
OPENAI_BASE_URL=http://127.0.0.1:11434/v1   # Ollama example
OPENAI_API_KEY=ollama                        # any non-empty placeholder the server accepts
```

| Serving stack | Endpoint | Notes |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | `ollama serve`; model id from `ollama list` |
| vLLM | `http://127.0.0.1:8000/v1` | `--served-model-name` sets the id |
| LM Studio | `http://127.0.0.1:1234/v1` | enable the local server in the app |

Keep the endpoint on loopback or your LAN; the API key never leaves the server regardless.

## Model admission bar

The agent loop depends on reliable **tool calling**. A model is admitted for real use only if it consistently:

1. Emits well-formed tool calls (correct name, schema-valid arguments) — malformed calls surface as tool errors and burn steps against the 16-step cap.
2. Stops calling tools after `finish_task` / `ask_user` / a prepare tool (the engine returns a pause marker; models that ignore it thrash until the step cap).
3. Keeps a full task within its context window: the system prompt carries memories, prior state, evidence and artifacts, and GitHub diffs are clipped to ~30k characters.

Small models (< ~14B parameters) routinely fail 1–2. If a model fails the bar, the failure mode is a task that ends `failed` with the tool error recorded — switch `AGENT_BACKEND=sample` to keep demo workflows running without a model.

**Verified-model list:** none yet. The pathway is fixture-verified; specific local models have not been benchmarked against the admission bar. Update this section with measured results before recommending one.

## Failure behavior (verified)

- **Endpoint unreachable** (e.g. Ollama not running): the task ends `failed` with the provider error recorded; the task remains retryable (`control: retry`) once the endpoint is back. Transient provider failures are retried in-loop with backoff (`MODEL_MAX_RETRIES`, [config.ts](../apps/server/src/config.ts)); external writes never re-fire — they are dispatched outside the model loop through reviewed, idempotency-keyed actions.
- **Model id missing on the gateway**: with `OPENAI_BASE_URL` set, prefix the id with `openai/` and match the serving stack's exact model name.
- **Provider keys stay server-side** in every mode; the browser/phone never sees them.

## Privacy boundary

With a local endpoint, prompts (including repository content and personal context) never leave the host. Pair with `THREADS_BACKEND=local` ([Issue #8](https://github.com/Colin4k1024/openmuse/issues/8)) for fully local conversation persistence; until then, CopilotKit Intelligence remains a cloud dependency for thread storage.
