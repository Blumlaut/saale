/**
 * Which file a chat is showing, read off its own transcript.
 *
 * `show_file` is the one call that means "look at this", so the newest finished
 * one is what a file panel opens. Nothing is stored: the transcript already
 * holds the call, and a chat reopened tomorrow still names the file it shared.
 */

import { previewKindFromPath } from "@/lib/editor/editor-utils";
import { mimeTypeForName, previewKindFor } from "@/lib/files/mime";
import { baseName } from "@/lib/files/paths";

/** The tool whose call is a request to see a file. */
export const SHOW_FILE_TOOL_NAME = "show_file";

/** One `show_file` call, as much of it as the panel needs. */
export interface ShownFile {
  /** The tool call's id, so a second share of the same file is a new show. */
  id: string;
  /** The path as the agent wrote it: relative to the chat, or absolute. */
  path: string;
}

interface ToolCallLike {
  id: string;
  name: string;
  status: string;
  args: Record<string, unknown>;
}

interface MessageLike {
  toolCalls?: readonly ToolCallLike[] | null | undefined;
}

/**
 * The newest file the chat shared, or null.
 *
 * Only files the panel can render are reported: a zip or an executable is
 * delivered by the card in the transcript, and opening an empty panel for it
 * would promise a view that does not exist.
 */
export function latestShownFile(messages: readonly MessageLike[]): ShownFile | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const calls = messages[index]?.toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (!call || call.name !== SHOW_FILE_TOOL_NAME || call.status !== "completed") continue;
      const path = typeof call.args.filePath === "string" ? call.args.filePath : "";
      if (!path) continue;
      return renderable(path) ? { id: call.id, path } : null;
    }
  }
  return null;
}

/** Whether a file panel has something to show: text, or a previewable type. */
function renderable(path: string): boolean {
  const name = baseName(path);
  return (
    previewKindFor(name, mimeTypeForName(name)) !== "binary" || previewKindFromPath(path) !== null
  );
}
