/**
 * Which workspace a request is about.
 *
 * The client sends one opaque token (`user`); this module turns it into a
 * provider plus the metadata a header needs. Keeping the token opaque means the
 * browser component never learns what it is browsing, which is what makes it
 * reusable.
 */

import { createLocalFileProvider } from "./local-provider";
import { userWorkspacePath, workspaceOwner } from "@/lib/sandbox/workspace";
import { FULL_CAPABILITIES, type FileTargetInfo } from "./types";
import type { FileProvider } from "./provider";

/** The token for a user's own workspace. */
export const USER_FILE_TARGET = "user";

/** A resolved workspace: the backend, and what to tell the client about it. */
export interface OpenedFileTarget {
  provider: FileProvider;
  info: FileTargetInfo;
}

/**
 * A user's own workspace.
 *
 * The same directory the agent's tools work in: the workspaces volume is
 * mounted into the app at the path the container sees, so a browse, an upload
 * and a `cat` all address the same file with the same string.
 */
export async function openUserFileTarget(userId: string): Promise<OpenedFileTarget> {
  const root = userWorkspacePath(userId);
  return {
    provider: createLocalFileProvider({ root, owner: workspaceOwner() }),
    info: { id: USER_FILE_TARGET, label: "files", root, capabilities: FULL_CAPABILITIES },
  };
}
