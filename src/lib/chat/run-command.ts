/**
 * Running a slash command from the web chat.
 *
 * One request carries the command, its argument line, the option a sheet
 * handed back and any files the composer pointed at it. Files are staged the
 * same way a message's are, so `/edit` reaches its pictures without the upload
 * passing through this request.
 */

import type { CommandOutcome, CommandPrompt } from "@/lib/commands/types";
import type { UploadProgress, StagedFile } from "@/lib/files/upload-client";
import { discardStaged, stageAttachments } from "./stage-attachments";

/** Response of `POST /api/chat/sessions/:id/command`. */
export type CommandApiResponse =
  | { kind: "prompt"; name: string; prompt: CommandPrompt }
  | { kind: "done"; name: string; outcome: CommandOutcome };

export type RunCommandResult =
  { kind: "ok"; response: CommandApiResponse } | { kind: "error"; message: string };

export interface RunCommandInput {
  sessionId: string;
  name: string;
  args?: string | undefined;
  /** The option an interactive command's sheet handed back. */
  value?: string | undefined;
  /** Files pointed at the command, when it takes any. */
  files?: readonly File[] | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: UploadProgress | null) => void) | undefined;
}

export async function runChatCommand(input: RunCommandInput): Promise<RunCommandResult> {
  let staged: StagedFile[] = [];
  if (input.files && input.files.length > 0) {
    const staging = await stageAttachments(input.files, input);
    if (!staging.ok) return { kind: "error", message: staging.message };
    staged = staging.staged;
  }

  const res = await fetch(`/api/chat/sessions/${input.sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      ...(input.args ? { args: input.args } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(staged.length > 0 ? { attachments: staged } : {}),
    }),
    signal: input.signal ?? null,
  });

  if (!res.ok) {
    // Nothing adopted the staged files, so they would sit in the scratch
    // directory until it is emptied.
    await discardStaged(staged);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { kind: "error", message: body.error || res.statusText };
  }

  return { kind: "ok", response: (await res.json()) as CommandApiResponse };
}
