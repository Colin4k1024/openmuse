import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { Store } from "./db.ts";
import { ownerContext } from "./threads-context.ts";

/** Thread rows mirror the parts of the Intelligence ThreadSummary the fork consumes. */
export interface LocalThreadSummary {
  id: string;
  name: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  agentId: string;
}

/** The journal record for one thread: the compacted AG-UI event stream of every run. */
interface ThreadEventsRecord {
  id: string;
  events: Array<Record<string, unknown>>;
}

export interface LocalThreadMessage {
  id: string;
  role: string;
  content?: string;
  toolCallId?: string;
}

const threadsKind = "threads";
const eventsKind = "thread-events";

/**
 * Owner-scoped thread persistence on the install's own Store (PGlite or
 * Postgres). No CopilotKit Intelligence request is made from this class.
 */
export class ThreadStore {
  constructor(private readonly db: Store) {}

  async list(
    owner: string,
    options: { agentId?: string; includeArchived?: boolean; limit?: number } = {},
  ): Promise<{ threads: LocalThreadSummary[]; nextCursor: null }> {
    const rows = await this.db.list<LocalThreadSummary>(owner, threadsKind);
    const threads = rows
      .filter(
        (thread) =>
          (options.agentId ? thread.agentId === options.agentId : true) &&
          (options.includeArchived || !thread.archived),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      threads: options.limit && options.limit > 0 ? threads.slice(0, options.limit) : threads,
      nextCursor: null,
    };
  }

  async get(owner: string, threadId: string): Promise<LocalThreadSummary | null> {
    return this.db.get<LocalThreadSummary>(owner, threadsKind, threadId);
  }

  /** Creates the row if absent (main thread and client-minted side chats). */
  async getOrCreate(
    owner: string,
    threadId: string,
    agentId: string,
  ): Promise<{ thread: LocalThreadSummary; created: boolean }> {
    const existing = await this.get(owner, threadId);
    if (existing) return { thread: existing, created: false };
    const now = new Date().toISOString();
    const thread: LocalThreadSummary = {
      id: threadId,
      name: null,
      archived: false,
      createdAt: now,
      updatedAt: now,
      agentId,
    };
    await this.db.put(owner, threadsKind, thread);
    return { thread, created: true };
  }

  async upsertSummary(owner: string, threadId: string, agentId: string): Promise<void> {
    await this.getOrCreate(owner, threadId, agentId);
  }

  async update(
    owner: string,
    threadId: string,
    updates: { name?: string; archived?: boolean },
  ): Promise<LocalThreadSummary | null> {
    const existing = await this.get(owner, threadId);
    if (!existing) return null;
    const thread: LocalThreadSummary = {
      ...existing,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.archived !== undefined ? { archived: updates.archived } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, threadsKind, thread);
    return thread;
  }

  async remove(owner: string, threadId: string): Promise<boolean> {
    if (!(await this.get(owner, threadId))) return false;
    await this.db.remove(owner, threadsKind, threadId);
    await this.db.remove(owner, eventsKind, threadId);
    return true;
  }

  async listEvents(owner: string, threadId: string): Promise<Array<Record<string, unknown>>> {
    const record = await this.db.get<ThreadEventsRecord>(owner, eventsKind, threadId);
    return record?.events ?? [];
  }

  /** Overwrites the journal with the runner's compacted event list (idempotent). */
  async saveEvents(
    owner: string,
    threadId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.db.put(owner, eventsKind, { id: threadId, events });
  }

  async touch(owner: string, threadId: string): Promise<void> {
    const existing = await this.get(owner, threadId);
    if (!existing) return;
    const now = new Date().toISOString();
    await this.db.put(owner, threadsKind, { ...existing, updatedAt: now, lastRunAt: now });
  }

  /**
   * Folds the event journal into a message list for the REST history
   * endpoint. The mobile app hydrates via the connect replay (the SDK
   * injects run input messages into RUN_STARTED), so this is contract
   * parity, not the app's hydration path.
   */
  async getMessages(owner: string, threadId: string): Promise<LocalThreadMessage[]> {
    const events = await this.listEvents(owner, threadId);
    const messages = new Map<string, LocalThreadMessage>();
    const seed = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const message of list) {
        if (!message || typeof message !== "object") continue;
        const { id, role, content } = message as Record<string, unknown>;
        if (typeof id !== "string" || typeof role !== "string") continue;
        messages.set(id, {
          id,
          role,
          ...(typeof content === "string" ? { content } : {}),
        });
      }
    };
    for (const event of events) {
      switch (event.type) {
        case "RUN_STARTED":
          seed((event.input as Record<string, unknown> | undefined)?.messages);
          break;
        case "MESSAGES_SNAPSHOT":
          messages.clear();
          seed(event.messages);
          break;
        case "TEXT_MESSAGE_START":
          if (typeof event.messageId === "string" && typeof event.role === "string")
            messages.set(event.messageId, { id: event.messageId, role: event.role, content: "" });
          break;
        case "TEXT_MESSAGE_CONTENT":
          if (typeof event.messageId === "string" && typeof event.delta === "string") {
            const message = messages.get(event.messageId);
            if (message) message.content = (message.content ?? "") + event.delta;
          }
          break;
        case "TOOL_RESULT":
          if (typeof event.toolCallId === "string")
            messages.set(event.toolCallId, {
              id: event.toolCallId,
              role: "tool",
              ...(typeof event.content === "string" ? { content: event.content } : {}),
              toolCallId: event.toolCallId,
            });
          break;
      }
    }
    return [...messages.values()];
  }
}

function unauthorized() {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function threadNotFound(threadId: string) {
  return Response.json({ error: `Thread ${threadId} was not found` }, { status: 404 });
}

const validAgentId = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 128;

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Serves the thread REST surface from the local store when the runtime runs
 * in SSE mode (THREADS_BACKEND=local). Reads and mutations are scoped to the
 * ALS owner captured around `runtime.fetch`; a forged `userId` in the query
 * or body is ignored. Interception happens in `onBeforeHandler`, which
 * short-circuits by throwing a Response.
 */
export function buildThreadHooks(store: ThreadStore): CopilotRuntimeHooks {
  return {
    async onBeforeHandler({ route, request }) {
      const owner = ownerContext.getStore();
      if (!owner) throw unauthorized();
      switch (route.method) {
        case "threads/list": {
          const url = new URL(request.url);
          const agentId = url.searchParams.get("agentId") ?? "";
          if (!validAgentId(agentId))
            throw Response.json(
              { error: "Valid agentId query param is required" },
              { status: 400 },
            );
          const result = await store.list(owner, {
            agentId,
            includeArchived: url.searchParams.get("includeArchived") === "true",
            limit: Number(url.searchParams.get("limit") ?? "") || undefined,
          });
          throw Response.json(result);
        }
        case "threads/update": {
          const threadId = route.threadId;
          if (request.method.toUpperCase() === "DELETE") {
            const removed = await store.remove(owner, threadId);
            if (!removed) throw threadNotFound(threadId);
            throw Response.json({ threadId, deleted: true });
          }
          const body = await readJsonBody(request);
          if (!validAgentId(body.agentId))
            throw Response.json({ error: "Valid agentId is required" }, { status: 400 });
          const updates: { name?: string; archived?: boolean } = {};
          if (typeof body.name === "string") updates.name = body.name;
          if (body.archived === false) updates.archived = false;
          const thread = await store.update(owner, threadId, updates);
          if (!thread) throw threadNotFound(threadId);
          throw Response.json(thread);
        }
        case "threads/archive": {
          const threadId = route.threadId;
          const body = await readJsonBody(request);
          if (!validAgentId(body.agentId))
            throw Response.json({ error: "Valid agentId is required" }, { status: 400 });
          const thread = await store.update(owner, threadId, { archived: true });
          if (!thread) throw threadNotFound(threadId);
          throw Response.json({ threadId, archived: true });
        }
        case "threads/messages": {
          const messages = await store.getMessages(owner, route.threadId);
          throw Response.json({ messages });
        }
        case "threads/events": {
          const events = await store.listEvents(owner, route.threadId);
          throw Response.json({ events });
        }
        case "threads/state": {
          throw Response.json({ state: null });
        }
        case "threads/clear": {
          // The runtime's clear wipes a process-global store across all
          // owners; local mode deliberately denies it.
          throw Response.json(
            { error: "threads/clear is not available with THREADS_BACKEND=local" },
            { status: 405 },
          );
        }
        default:
          return;
      }
    },
    async onResponse({ route, response }) {
      if (route.method !== "info") return;
      // SSE mode reports mutations:false, which makes the client reject
      // rename/archive/unarchive calls before they reach the server. Local
      // mode serves those mutations, so advertise them.
      const body = (await response.json()) as Record<string, unknown>;
      const threadEndpoints = {
        ...((body.threadEndpoints as Record<string, unknown> | undefined) ?? {}),
        list: true,
        inspect: true,
        mutations: true,
        realtimeMetadata: false,
      };
      return Response.json(
        { ...body, threadEndpoints },
        { status: response.status, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}
