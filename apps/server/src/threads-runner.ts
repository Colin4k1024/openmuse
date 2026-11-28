import type { BaseEvent } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  InMemoryAgentRunner,
  type LocalThreadEndpointRunner,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import type { ThreadStore } from "./threads.ts";
import { ownerContext } from "./threads-context.ts";

const anonymousOwner = "anonymous";

/**
 * A durable AgentRunner for THREADS_BACKEND=local. The runtime runs in SSE
 * mode and executes agents in-process through the wrapped InMemoryAgentRunner;
 * this class mirrors the inner runner's compacted event journal (including
 * the run input messages the SDK injects into RUN_STARTED) into the
 * owner-scoped ThreadStore, and replays it from the store on connect so
 * `copilotkit.connectAgent` works across full process restarts.
 *
 * ɵsupportsLocalThreadEndpoints stays unset: thread reads are served by the
 * owner-scoped Hono hooks, not by this runner.
 */
export class DurableThreadRunner extends AgentRunner {
  private readonly inner: InMemoryAgentRunner & LocalThreadEndpointRunner;

  constructor(private readonly store: ThreadStore) {
    super();
    this.inner = new InMemoryAgentRunner() as InMemoryAgentRunner & LocalThreadEndpointRunner;
  }

  private owner(): string {
    // run/connect are invoked inside the request's async context; only code
    // outside the Hono path (nothing today) falls back to anonymous.
    return ownerContext.getStore() ?? anonymousOwner;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const owner = this.owner();
    const agentId = request.agent.agentId ?? "default";
    void this.store.upsertSummary(owner, request.threadId, agentId).catch((error) => {
      console.error("[OpenFuse] local thread summary upsert failed", error);
    });
    const source = this.inner.run(request);
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    // Persist after the stream settles: the inner runner finalizes, compacts
    // and appends the run exactly once, so this mirrors the final journal.
    const persist = async () => {
      try {
        const events = this.inner.getThreadEvents(request.threadId);
        await this.store.saveEvents(
          owner,
          request.threadId,
          events as Array<Record<string, unknown>>,
        );
        await this.store.touch(owner, request.threadId);
      } catch (error) {
        // A failed journal write degrades to the in-memory behavior of the
        // SSE runner; the run itself already streamed to the client.
        console.error("[OpenFuse] local thread journal save failed", error);
      }
    };
    source.subscribe({
      next: (event) => subject.next(event),
      complete: () => {
        void persist().finally(() => subject.complete());
      },
      error: (error) => {
        void persist().finally(() => subject.error(error));
      },
    });
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const owner = this.owner();
    return new Observable<BaseEvent>((subscriber) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          subscriber.complete();
        }
      };
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          subscriber.error(error instanceof Error ? error : new Error(String(error)));
        }
      };
      void (async () => {
        // Read the durable journal first: after a restart it is the only
        // history; while a run is in flight it lags the inner store by at
        // most the current (unfinalized) run.
        const stored = await this.store.listEvents(owner, request.threadId);
        for (const event of stored) subscriber.next(event as unknown as BaseEvent);
        if (!(await this.inner.isRunning({ threadId: request.threadId }))) {
          finish();
          return;
        }
        // The inner runner is mid-run: inner.connect replays its compacted
        // journal (which we just emitted from the store) and then tails the
        // live run. Skip exactly the historic prefix; the live tail carries
        // new events only.
        let skip = this.inner.getThreadEvents(request.threadId).length;
        this.inner.connect(request).subscribe({
          next: (event) => {
            if (skip > 0) {
              skip -= 1;
              return;
            }
            subscriber.next(event);
          },
          complete: finish,
          error: fail,
        });
      })().catch(fail);
    });
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.inner.isRunning(request);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    return this.inner.stop(request);
  }
}
