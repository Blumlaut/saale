/**
 * Which workspace a request is about.
 *
 * The client sends one opaque token (`user`, or `council:<id>`); this module
 * turns it into a provider plus the metadata a header needs. Keeping the token
 * opaque means the browser component never learns what it is browsing, which is
 * what makes it reusable — a new kind of workspace is a new scheme here and a
 * new page, not a new component.
 */

import * as terminal from "@/lib/terminal/client";
import path from "node:path";
import { getUploadsDir } from "@/lib/uploads";
import { createLocalFileProvider } from "./local-provider";
import { createTerminalFileProvider } from "./terminal-provider";
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
 * Prefers the terminal container when it is configured — that is where a user's
 * agents actually work — and falls back to the app's uploads volume otherwise,
 * the same pair of locations the chat workspace routes use.
 *
 * `sessionId` rides along as Open Terminal's chat header, so the container's log
 * attributes a read to the conversation that asked for it. A browser request has
 * no chat and omits it.
 */
export async function openUserFileTarget(
  userId: string,
  options: { sessionId?: string } = {},
): Promise<OpenedFileTarget> {
  if (terminal.isConfigured()) {
    const root = terminal.getTerminalHomeDir(userId);
    return {
      provider: createTerminalFileProvider({ identity: userId, root, ...options }),
      info: { id: USER_FILE_TARGET, label: "Your files", root, capabilities: FULL_CAPABILITIES },
    };
  }

  const root = path.join(getUploadsDir(), userId);
  return {
    provider: createLocalFileProvider({ root }),
    info: { id: USER_FILE_TARGET, label: "Your files", root, capabilities: FULL_CAPABILITIES },
  };
}
