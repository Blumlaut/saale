import type { CoderProvisioning } from "./use-coder-data";

/**
 * What each stage of building a workspace is doing.
 *
 * One source, because two places say it: the card above the chat's composer and
 * the empty worktree panel, and a step that sounds different in each is how a
 * user concludes they are two different problems.
 */
export const PROVISIONING_STEP_COPY: Record<
  CoderProvisioning["step"],
  { label: string; detail: string }
> = {
  worktree: {
    label: "Checking out the worktree",
    detail: "This chat gets its own branch of the project to work on.",
  },
  setup: {
    label: "Running setup script",
    detail: "This may take a few minutes",
  },
};
