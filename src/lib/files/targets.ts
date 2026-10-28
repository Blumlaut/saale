/**
 * Which workspace a request is about.
 *
 * The client sends one opaque token (`user`, or `council:<id>`); this module
 * turns it into a provider plus the metadata a header needs. Keeping the token
 * opaque means the browser component never learns what it is browsing, which is
 * what makes it reusable. a new kind of workspace is a new scheme here and a
 * new page, not a new component.
 */

import { createLocalFileProvider } from "./local-provider";
import { userWorkspacePath, workspaceOwner } from "@/lib/sandbox/workspace";
import { FULL_CAPABILITIES, type FileTargetInfo } from "./types";
import type { FileProvider } from "./provider";

/** The token for a user's own workspace. */
export const USER_FILE_TARGET = "user";

export type FileTargetRef = { kind: "user" } | { kind: "council"; councilId: string };

/** Parse a `target` query parameter. `null` means the token is not valid. */
export function parseFileTarget(raw: string | null): FileTargetRef | null {
  if (raw === null || raw === "" || raw === USER_FILE_TARGET) return { kind: "user" };
  if (raw.startsWith("council:")) {
    const councilId = raw.slice("council:".length);
    return councilId ? { kind: "council", councilId } : null;
  }
  return null;
}

export function formatFileTarget(ref: FileTargetRef): string {
  return ref.kind === "user" ? USER_FILE_TARGET : `council:${ref.councilId}`;
}

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
