import { z } from "zod";

/** Daily GitHub digest configuration and runtime record (Issue #5). */

export const digestConfigSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  repos: z.array(z.string().trim().min(3).max(200)).min(1).max(20),
  /** Local hour (0-23) at which the digest runs. */
  hour: z.number().int().min(0).max(23).default(9),
});
export type DigestConfigInput = z.infer<typeof digestConfigSchema>;

export interface DigestRecord {
  id: string;
  taskId: string;
  title: string;
  repos: string[];
  hour: number;
  status: "active" | "paused" | "stopped";
  nextRunAt: string;
  lastRunDay?: string;
  failures?: number;
  error?: string | null;
  createdAt: string;
}

/** Local YYYY-MM-DD, the exactly-once key for a digest run. */
export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The next local datetime at `hour` strictly after `now`. */
export function nextRunAfter(now: Date, hour: number): string {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export interface DigestSection {
  repo: string;
  openPrs: { number: number; title: string; url: string; draft: boolean }[];
  failingChecks: { pr: number; checks: string[] }[];
  openIssues: { number: number; title: string; url: string; labels: string[] }[];
}

export function buildDigestSummary(date: string, sections: DigestSection[]): string {
  const lines = [`# GitHub digest — ${date}`, ""];
  for (const section of sections) {
    lines.push(`## ${section.repo}`);
    if (!section.openPrs.length && !section.openIssues.length && !section.failingChecks.length) {
      lines.push("All clear: no open PRs or issues.");
      lines.push("");
      continue;
    }
    if (section.openPrs.length) {
      lines.push(`Open PRs (${section.openPrs.length}):`);
      for (const pr of section.openPrs)
        lines.push(`- #${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""} — ${pr.url}`);
    }
    if (section.failingChecks.length) {
      lines.push("Failing checks:");
      for (const failure of section.failingChecks)
        lines.push(`- PR #${failure.pr}: ${failure.checks.join(", ")}`);
    }
    if (section.openIssues.length) {
      lines.push(`Open issues (${section.openIssues.length}):`);
      for (const issue of section.openIssues)
        lines.push(
          `- #${issue.number} ${issue.title}${issue.labels.length ? ` [${issue.labels.join(", ")}]` : ""} — ${issue.url}`,
        );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
