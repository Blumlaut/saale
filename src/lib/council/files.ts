/**
 * A council's shared workspace, seen through the file browser.
 *
 * The workspace is one directory per council, named by the council's stored
 * `sandboxKey`. Every member works in it, so it is the sandbox root itself that
 * gets browsed, not a member's private folder.
 *
 * Two things this deliberately does *not* do: it does not touch the owner's
 * workspace (the provider is rooted at the council's directory), and it does not
 * decide who may look. that is `requireCouncilAccess` in the route, the same
 * gate every other council endpoint uses.
 */

import { createLocalFileProvider } from "@/lib/files/local-provider";
import type { OpenedFileTarget } from "@/lib/files/targets";
import { FULL_CAPABILITIES } from "@/lib/files/types";
import { workspaceOwner } from "@/lib/sandbox/workspace";
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

  const identity = sandboxIdentity(council.sandboxKey);
  await ensureCouncilSandbox(identity);

  return {
    provider: createLocalFileProvider({ root: identity.path, owner: workspaceOwner() }),
    info: {
      id: `council:${councilId}`,
      label: council.name,
      root: identity.path,
      capabilities: FULL_CAPABILITIES,
    },
  };
}
