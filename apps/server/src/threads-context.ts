import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The authenticated owner of the in-flight CopilotKit runtime request. The
 * thread store and the durable runner are owner-scoped, so every
 * `runtime.fetch` call is wrapped in `ownerContext.run(owner, ...)`.
 */
export const ownerContext = new AsyncLocalStorage<string>();
