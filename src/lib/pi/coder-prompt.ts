/**
 * System prompt for a coder chat.
 *
 * A coder chat works in one git worktree of one project, so it gets an identity
 * that is about code, the git rules the panel's bookkeeping assumes, and the
 * same capability blocks a chat gets for the tool categories it has enabled.
 */

import { capabilitySections } from "./processing-state";

const CODER_IDENTITY_PROMPT = `You are Saale's coding agent. You work in one git worktree that belongs to one project inside the user's workspace.

The worktree is the whole of your filesystem authority. Every path outside it is out of bounds: the project's main checkout, its other worktrees, the rest of the workspace and the host. Read and write files inside the worktree with the tools you have. Commands you run start in it.`;

const GIT_PROMPT = `Git:
- Commit as work lands, in small commits that each do one thing.
- The subject line is imperative and shorter than 50 characters. No attribution trailers and no "Generated with" footer.
- Run the project's own checks (tests, lint, typecheck) before you commit, and fix what they report.
- Never pass \`--force\` to a git command.
- Never push unless the user asks for it.
- Only this worktree's branch is yours to change.
- Never rewrite history that exists on a remote.`;

const REPORTING_PROMPT = `Reporting:
End a turn by saying what you changed, what you committed and what is still uncommitted in the worktree.`;

/** Added only when the user has a token configured. a name, never a value. */
const GH_TOKEN_PROMPT = `\`GH_TOKEN\` is set in your environment, so \`gh\` and \`git\` can reach private repositories without asking for credentials.`;

/**
 * Build a coder chat's system prompt.
 *
 * Identity first, the user's own instructions next, then the git rules and the
 * capability blocks the enabled tool categories bring. A category that is off
 * contributes nothing, so the prompt never describes a tool the session cannot
 * call. The caller passes the coder tool config: its defaults are the coder
 * ones, which this module does not assume.
 */
export function buildCoderSystemPrompt(options: {
  customInstructions?: string | null | undefined;
  toolConfig?: Record<string, unknown> | undefined;
  /** Names of the user's sandbox variables. never their values. */
  sandboxEnvNames?: string[] | undefined;
}): string {
  const toolConfig = (options.toolConfig ?? {}) as Record<string, boolean | undefined>;
  const envNames = options.sandboxEnvNames ?? [];
  const customInstructions = options.customInstructions?.trim();

  const sections = [
    CODER_IDENTITY_PROMPT,
    customInstructions ? `Custom instructions:\n${customInstructions}` : null,
    GIT_PROMPT,
    envNames.includes("GH_TOKEN") ? GH_TOKEN_PROMPT : null,
    REPORTING_PROMPT,
    ...capabilitySections(toolConfig, envNames),
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}
