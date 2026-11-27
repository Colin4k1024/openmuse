import { createHash } from "node:crypto";
import { type ProposalInput, proposalSchema } from "../../../packages/domain/src/index.ts";
import { GitHubError } from "../../../packages/integrations/src/github.ts";
import { AppError } from "./errors.ts";
import type { GitHubAuth } from "./github-auth.ts";

/**
 * Executes human-approved GitHub proposals (Issue #6). Every operation looks up
 * before it creates, so a post-approval crash recovery never duplicates an
 * external write; an uncertain outcome fails the proposal for human
 * reconciliation instead of retrying blindly.
 */
export class GitHubExecutor {
  constructor(private readonly github: GitHubAuth) {}

  async execute(owner: string, raw: ProposalInput): Promise<string> {
    const input = proposalSchema.parse(raw);
    if (!input.kind.startsWith("github."))
      throw new AppError(`GitHubExecutor cannot execute ${input.kind}`, 400);
    const adapter = await this.github.adapterFor(owner);
    try {
      switch (input.kind) {
        case "github.create_branch": {
          const { repo, branch, fromSha } = input.data;
          const result = await adapter.createBranch(repo, branch, fromSha);
          return result.created
            ? `Created branch ${branch} at ${result.sha.slice(0, 12)} in ${repo}`
            : `Branch ${branch} already exists at ${result.sha.slice(0, 12)} in ${repo}`;
        }
        case "github.commit_files": {
          const { repo, branch, message, files } = input.data;
          const result = await adapter.commitFiles(repo, branch, message, files);
          return `Committed ${files.length} file(s) to ${repo}:${branch} as ${result.sha.slice(0, 12)}`;
        }
        case "github.open_pr": {
          const { repo, head, base, title, body } = input.data;
          const result = await adapter.createPullRequest(repo, head, base, title, body);
          return result.created
            ? `Opened PR #${result.number}: ${result.url}`
            : `PR #${result.number} already open for ${head}: ${result.url}`;
        }
        case "github.comment": {
          const { repo, number, body } = input.data;
          const idemKey = createHash("sha256")
            .update(`github.comment:${repo}:${number}:${body}`)
            .digest("hex")
            .slice(0, 16);
          const result = await adapter.addComment(repo, number, body, idemKey);
          return result.created
            ? `Commented on ${repo}#${number}: ${result.url}`
            : `Comment already posted on ${repo}#${number}: ${result.url}`;
        }
        default:
          throw new AppError(`Unsupported GitHub action: ${input.kind}`, 400);
      }
    } catch (error) {
      // A mid-execution 401 revokes the connection: clear it and expire the
      // remaining pending proposals bound to it (#3 lifecycle).
      if (error instanceof GitHubError && error.code === "auth_failed")
        await this.github.invalidate(owner);
      throw error;
    }
  }
}
