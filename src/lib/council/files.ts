/**
 * A council's shared workspace, seen through the file browser.
 *
 * The workspace is one directory per council, owned by a Linux account derived
 * from the council's stored `sandboxKey` — every member works in it, so it is
 * the sandbox root itself that gets browsed, not a member's private folder.
 *
 * Two things this deliberately does *not* do: it does not touch the user's own
 * workspace (the identity passed to Open Terminal is the sandbox key, so the
 * kernel applies the sandbox's permissions, not the caller's), and it does not
 * decide who may look — that is `requireCouncilAccess` in the route, the same
 * gate every other council endpoint uses.
 */

import { createTerminalFileProvider } from "@/lib/files/terminal-provider";
import { WorkspaceUnavailableError } from "@/lib/files/errors";
import type { OpenedFileTarget } from "@/lib/files/targets";
import { FULL_CAPABILITIES } from "@/lib/files/types";
import * as terminal from "@/lib/terminal/client";
import { sandboxIdentity } from "./accounts";
import { ensureCouncilSandbox } from "./sandbox";
import { getCouncilSandboxRef } from "./store";

/**
 * Open a council's workspace, or null when the council does not exist.
 *
 * Provisioning happens here, not just before a run: seeding a workspace with
 * reference material *before* convening is a reason to browse it at all, and a
 * council created a minute ago has no directory until something asks for one.
 * `ensureCouncilSandbox` is idempotent and is the same call the run makes.
 */
export async function openCouncilFileTarget(
  userId: string,
  councilId: string,
): Promise<OpenedFileTarget | null> {
  const council = await getCouncilSandboxRef(userId, councilId);
  if (!council) return null;

  if (!terminal.isConfigured()) {
    throw new WorkspaceUnavailableError(
      "Council workspaces need the Open Terminal integration to be configured.",
    );
  }

  const identity = sandboxIdentity(council.sandboxKey);
  await ensureCouncilSandbox(identity);

  return {
    provider: createTerminalFileProvider({ identity: identity.key, root: identity.home }),
    info: {
      id: `council:${councilId}`,
      label: council.name,
      root: identity.home,
      capabilities: FULL_CAPABILITIES,
    },
  };
}
