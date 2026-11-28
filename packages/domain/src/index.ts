import { z } from "zod";

export type WorkspaceMode = "sample" | "live";
export type Section =
  | "today"
  | "chat"
  | "mail"
  | "calendar"
  | "browser"
  | "files"
  | "activity"
  | "connections"
  | "ideas"
  | "goals"
  | "apps";
export interface Mail {
  id: string;
  threadId: string;
  from: string;
  sender: string;
  to: string[];
  subject: string;
  body: string;
  date: string;
  unread: boolean;
  label: string;
  attachments: string[];
}
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
}
export const calendarRangeSchema = z
  .object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
  })
  .refine(({ timeMin, timeMax }) => {
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    return duration > 0 && duration <= 366 * 86400000;
  }, "Calendar range must end after it starts and span at most 366 days");
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  url: string;
  createdAt: string;
  source: string;
  parentId?: string;
  fields?: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}
export interface BrowserSession {
  id: string;
  title: string;
  url: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
}
// Invisible characters that reorder or hide text without showing on the review card. Joiners and
// directional marks stay because emoji sequences, Persian and Arabic text depend on them.
const hiddenText = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const visibleText = () => z.string().overwrite((text) => text.replace(hiddenText, ""));
export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: visibleText()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: visibleText().min(1).max(100000),
  attachmentIds: z.array(z.string()).max(10).default([]),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
});
export const eventDraftSchema = z
  .object({
    calendarId: z.string().default("primary"),
    title: visibleText().trim().min(1).max(500),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().default(false),
    timeZone: z.string().default("America/Los_Angeles"),
    location: visibleText().max(2000).default(""),
    description: visibleText().max(10000).default(""),
    attendees: z.array(z.email()).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      !Number.isFinite(Date.parse(value.start)) ||
      !Number.isFinite(Date.parse(value.end)) ||
      Date.parse(value.end) <= Date.parse(value.start)
    ) {
      ctx.addIssue({ code: "custom", message: "End must be after a valid start", path: ["end"] });
    }
    const dateOnly = z.iso.date();
    const timed = z.union([
      z.iso.datetime({ offset: true }),
      z.iso.datetime({ offset: true, precision: -1 }),
    ]);
    // Keep minute precision while validating the clock time as well as the date.
    const validTimestamp = (timestamp: string) =>
      value.allDay ? dateOnly.safeParse(timestamp).success : timed.safeParse(timestamp).success;
    if (!validTimestamp(value.start) || !validTimestamp(value.end)) {
      ctx.addIssue({
        code: "custom",
        message: value.allDay
          ? "All-day events need valid date-only values"
          : "Timed events need valid date-times with an explicit offset",
        path: ["start"],
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid time zone", path: ["timeZone"] });
    }
  });
const githubRepoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repo");
const githubBranchSchema = z
  .string()
  .min(1)
  .max(200)
  // Characters that corrupt gh api paths/queries or git ref parsing.
  .regex(/^[^\s~^:?#&%+*[\]\\]+$/, "Branch name contains unsupported characters");
export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email.send"), data: emailDraftSchema }),
  z.object({ kind: z.literal("calendar.create"), data: eventDraftSchema }),
  z.object({
    kind: z.literal("calendar.update"),
    data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })),
  }),
  z.object({
    kind: z.literal("calendar.delete"),
    data: z.object({ calendarId: z.string(), eventId: z.string().min(1), title: z.string() }),
  }),
  z.object({
    kind: z.literal("github.create_branch"),
    data: z.object({
      repo: githubRepoSchema,
      branch: githubBranchSchema,
      fromSha: z.string().regex(/^[0-9a-f]{7,40}$/i, "Expected a commit SHA"),
    }),
  }),
  z.object({
    kind: z.literal("github.commit_files"),
    data: z.object({
      repo: githubRepoSchema,
      branch: githubBranchSchema,
      message: z.string().min(1).max(500),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(500),
            // Per-argument OS limits (~128KB) keep single contents below this.
            content: z.string().max(100_000),
          }),
        )
        .min(1)
        .max(20),
    }),
  }),
  z.object({
    kind: z.literal("github.open_pr"),
    data: z.object({
      repo: githubRepoSchema,
      head: githubBranchSchema,
      base: githubBranchSchema,
      title: z.string().min(1).max(300),
      body: z.string().max(60_000),
    }),
  }),
  z.object({
    kind: z.literal("github.comment"),
    data: z.object({
      repo: githubRepoSchema,
      number: z.number().int().positive(),
      body: z.string().min(1).max(60_000),
    }),
  }),
]);
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EventDraft = z.infer<typeof eventDraftSchema>;
export type ProposalInput = z.infer<typeof proposalSchema>;
export type GitHubProposalInput = Extract<ProposalInput, { kind: `github.${string}` }>;
export type WorkspaceProposalInput = Exclude<ProposalInput, GitHubProposalInput>;
export const isGitHubProposal = (input: ProposalInput): input is GitHubProposalInput =>
  input.kind.startsWith("github.");
export interface ActionProposal {
  target?: CalendarEvent;
  targetVersion?: string;
  taskId?: string;
  account?: string;
  connectionId?: string;
  id: string;
  title: string;
  kind: ProposalInput["kind"];
  data: Record<string, unknown>;
  status:
    | "awaiting_review"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  result?: string;
  error?: string;
}
export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  status: string;
  actionId?: string;
}
export interface Connection {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "sample" | "unconfigured" | "unavailable";
  account?: string;
  capabilities: string[];
}
export interface Workspace {
  mode: WorkspaceMode;
  profile: { name: string; email: string };
  mail: Mail[];
  events: CalendarEvent[];
  files: Artifact[];
  browsers: BrowserSession[];
  actions: ActionProposal[];
  activity: ActivityEntry[];
  connections: Connection[];
  runtime: {
    provider: "sample" | "model" | "openbot";
    configured: boolean;
    openbotConfigured: boolean;
    richThreads?: boolean;
    /** Where conversation threads persist: CopilotKit Intelligence or this install's own store. */
    threadsBackend?: "intelligence" | "local";
  };
}

/** Provider-independent boundary: OpenBot/AG-UI runs never dictate presentation. */
export interface ExecutionBackend {
  readonly kind: "standalone" | "openbot";
  readonly capabilities: readonly string[];
  health(): Promise<{ available: boolean; detail: string }>;
}

export type { ComputerCommand, ComputerDirectory, ComputerSnapshot } from "./computer.ts";
