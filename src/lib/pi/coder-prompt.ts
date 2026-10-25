/**
 * System prompt for a coder chat.
 *
 * A coder chat works in one checkout of one project, its own worktree or the
 * project's shared one, so it gets an identity that is about code, the git rules
 * the panel's bookkeeping assumes, and the same capability blocks a chat gets
 * for the tool categories it has enabled.
 */

import { capabilitySections } from "./processing-state";

const CODER_IDENTITY_PROMPT = `You are Saale's coding agent. You work in one git worktree that belongs to one project inside the user's workspace.

The worktree is the whole of your filesystem authority. Every path outside it is out of bounds: the project's main checkout, its other worktrees, the rest of the workspace and the host. Read and write files inside the worktree with the tools you have. Commands you run start in it.`;

/** The same identity, for a project whose chats share its one checkout. */
const SHARED_CHECKOUT_IDENTITY_PROMPT = `You are Saale's coding agent. You work in the checkout of one project inside the user's workspace, which every chat of that project runs in.

The checkout is the whole of your filesystem authority. Every path outside it is out of bounds: the rest of the workspace and the host. Read and write files inside the checkout with the tools you have. Commands you run start in it.`;

const GIT_PROMPT = `Git:
- Commit as work lands, in small commits that each do one thing.
- The subject line is imperative and shorter than 50 characters. No attribution trailers and no "Generated with" footer.
- Run the project's own checks (tests, lint, typecheck) before you commit, and fix what they report.
- Never pass \`--force\` to a git command.
- Never push unless the user asks for it.
- Never rewrite history that exists on a remote.`;

/** The git rules, with who owns the branch when the checkout is shared. */
function gitPrompt(sharedCheckout: boolean): string {
  const branchRule = sharedCheckout
    ? "- The checkout is shared with every other chat of this project, so leave its branch alone."
    : "- Only this worktree's branch is yours to change.";
  return `${GIT_PROMPT}\n${branchRule}`;
}

/**
 * The dev-server rules, with the preview domain when this deployment has one.
 *
 * A preview hostname is minted per port and carries a signature, so an app's
 * allow list can only name the domain as a wildcard, and only the agent that
 * writes the app's config can put it there.
 */
function devServerPrompt(previewDomain: string | null | undefined): string {
  const rules = [
    "Development servers:",
    "- When the user wants to see the app, start its dev server in the background and say which port it took. The chat's Ports panel lists every port the worktree is listening on and opens any of them as a preview.",
    "- Bind the server to `0.0.0.0`. A server on `127.0.0.1` is reachable only from inside the container, so no preview can load it.",
    "- A preview arrives on a hostname of its own, so a dev server that vets host names has to allow it: Vite has `server.allowedHosts`, and the panel shows a 403 while it is missing. Next's dev resources are handled for you.",
  ];
  if (previewDomain) {
    rules.push(
      `- An app that only answers on a hostname or origin it was configured with needs \`https://*.${previewDomain}\` allowed: better-auth \`trustedOrigins\`, Django \`ALLOWED_HOSTS\` and \`CSRF_TRUSTED_ORIGINS\`, Rails \`config.hosts\`. A preview hostname changes per port, so allow the wildcard, once, while you set the project up.`,
    );
  }
  return rules.join("\n");
}

const REPORTING_PROMPT = `Reporting:
End a turn by saying what you changed, what you committed and what is still uncommitted in the worktree.`;

const SHARED_CHECKOUT_REPORTING_PROMPT = `Reporting:
End a turn by saying what you changed, what you committed and what is still uncommitted in the checkout.`;

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
  /** The domain preview hostnames live under, when this deployment has one. */
  previewDomain?: string | null | undefined;
  /** Whether the session has tools behind codemode. See `capabilitySections`. */
  codemodeTools?: boolean | undefined;
  /** The checkout the chat runs in: its own worktree, or the project's one. */
  checkout?: "worktree" | "repo" | undefined;
}): string {
  const toolConfig = (options.toolConfig ?? {}) as Record<string, boolean | undefined>;
  const envNames = options.sandboxEnvNames ?? [];
  const customInstructions = options.customInstructions?.trim();
  const shared = options.checkout === "repo";

  const sections = [
    shared ? SHARED_CHECKOUT_IDENTITY_PROMPT : CODER_IDENTITY_PROMPT,
    customInstructions ? `Custom instructions:\n${customInstructions}` : null,
    gitPrompt(shared),
    devServerPrompt(options.previewDomain),
    envNames.includes("GH_TOKEN") ? GH_TOKEN_PROMPT : null,
    shared ? SHARED_CHECKOUT_REPORTING_PROMPT : REPORTING_PROMPT,
    ...capabilitySections(toolConfig, envNames, options.codemodeTools),
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}
