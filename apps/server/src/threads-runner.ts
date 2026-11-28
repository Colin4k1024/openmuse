import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
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

function runError(request: AgentRunnerRunRequest, message: string): BaseEvent {
  return {
    type: EventType.RUN_ERROR,
    message,
    threadId: request.threadId,
    runId: request.input.runId,
  } as unknown as BaseEvent;
}

/**
 * A durable AgentRunner for THREADS_BACKEND=local. The runtime runs in SSE
 * mode and executes agents in-process through the wrapped InMemoryAgentRunner;
 * this class mirrors the inner runner's compacted event journal (including
 * the run input messages the SDK injects into RUN_STARTED) into the
 * owner-scoped ThreadStore, and replays it from the store on connect so
 * `copilotkit.connectAgent` works across full process restarts.
 *
 * The inner store is volatile and bounded (process-global, keyed only by
 * thread id), so persistence is append-only: each write adds only the events
 * this process has not persisted yet, and the journal never shrinks. The
 * inner store also has no owner dimension, so run/connect verify thread
 * ownership first — a foreign thread id must not read or copy another
 * owner's journal.
 *
 * ɵsupportsLocalThreadEndpoints stays unset: thread reads are served by the
 * owner-scoped Hono hooks, not by this runner.
 */
export class DurableThreadRunner extends AgentRunner {
  private readonly inner: InMemoryAgentRunner & LocalThreadEndpointRunner;
  /** Per thread: how many events of the inner snapshot this process has persisted. */
  private readonly persistedLength = new Map<string, number>();

  constructor(private readonly store: ThreadStore) {
    super();
    this.inner = new InMemoryAgentRunner() as InMemoryAgentRunner & LocalThreadEndpointRunner;
  }

  private owner(): string {
    // run/connect are invoked inside the request's async context; only code
    // outside the Hono path (nothing today) falls back to anonymous.
    return ownerContext.getStore() ?? anonymousOwner;
  }

  private async guardOwnership(owner: string, threadId: string): Promise<void> {
    // The runner's in-process journal is keyed only by thread id, so a thread
    // owned by a different account must be rejected before any delegation.
    await this.store.assertNotForeign(owner, threadId);
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const owner = this.owner();
    const agentId = request.agent.agentId ?? "default";
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    // Persist after the stream settles: the inner runner finalizes, compacts
    // and appends the run exactly once, so the inner snapshot is final.
    const persist = async () => {
      try {
        const events = this.inner.getThreadEvents(request.threadId) as Array<
          Record<string, unknown>
        >;
        // Append-only: persist just the suffix this process has not written
        // yet. After a restart the inner snapshot starts empty, so the first
        // run appends its events to the durable journal instead of replacing
        // it. If the bounded inner snapshot ever truncates below the high
        // water mark, appending stops (until restart) rather than splicing a
        // misaligned partial run into the journal.
        const already = this.persistedLength.get(request.threadId) ?? 0;
        const suffix = events.length >= already ? events.slice(already) : [];
        if (events.length >= already) this.persistedLength.set(request.threadId, events.length);
        await this.store.appendEvents(owner, request.threadId, suffix);
        await this.store.touch(owner, request.threadId);
      } catch (error) {
        // A failed journal write degrades to the in-memory behavior of the
        // SSE runner; the run itself already streamed to the client.
        console.error("[OpenFuse] local thread journal save failed", error);
      }
    };
    void (async () => {
      try {
        // Ownership first: the in-process journal is keyed only by thread id,
        // so a run on another owner's thread would mix and copy histories.
        // Only this guard is fatal; its reason is safe to show the client.
        await this.guardOwnership(owner, request.threadId);
      } catch {
        subject.next(runError(request, "Thread belongs to a different owner"));
        subject.complete();
        return;
      }
      // A summary write is best-effort: a transient store failure must not
      // fail the user's turn (the SSE runner has no such row either).
      void this.store.upsertSummary(owner, request.threadId, agentId).catch((error) => {
        console.error("[OpenFuse] local thread summary upsert failed", error);
      });
      let source: Observable<BaseEvent>;
      try {
        // The inner runner throws synchronously for a concurrent run on the
        // same thread ("Thread already running"); that must surface as a
        // clean run error, never an unhandled rejection.
        source = this.inner.run(request);
      } catch {
        subject.next(runError(request, "A run is already in progress on this conversation"));
        subject.complete();
        return;
      }
      source.subscribe({
        next: (event) => subject.next(event),
        complete: () => {
          void persist().finally(() => subject.complete());
        },
        error: (error) => {
          void persist().finally(() => subject.error(error));
        },
      });
    })();
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
        await this.guardOwnership(owner, request.threadId);
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
        // new events only. A run that finalizes between the stored read and
        // this subscription can make the skip over-count; that run then
        // reaches the next connect instead (the journal is never corrupted).
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
