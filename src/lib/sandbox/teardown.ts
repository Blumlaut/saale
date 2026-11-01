/**
 * Removing a tenant entirely: its container and its directory.
 *
 * Best-effort and never throws. A user or a council that is already gone from
 * the database must not stay on the volume because the service was briefly
 * unreachable, but a cleanup that did not happen is reported. What is left
 * behind holds files.
 */

import * as sandboxClient from "./client";
import { userIdentity } from "./identity";
import { removeWorkspace } from "./workspace";

/** Remove an identity's container and its directory. */
export async function destroySandbox(identity: string): Promise<void> {
  if (sandboxClient.isConfigured()) {
    try {
      await sandboxClient.removeContainer(identity);
    } catch (err) {
      console.warn(`Could not remove the sandbox container ${identity}:`, err);
    }
  }

  try {
    await removeWorkspace(identity);
  } catch (err) {
    console.error(`Could not remove the sandbox directory ${identity}:`, err);
  }
}

/** Remove a user's own sandbox, for a user that is being deleted. */
export async function destroyUserSandbox(userId: string): Promise<void> {
  await destroySandbox(userIdentity(userId));
}
