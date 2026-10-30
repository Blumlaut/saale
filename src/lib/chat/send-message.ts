import type { Message } from "@/components/chat/types";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  isImageMime,
} from "@/lib/chat/attachment-limits";
import {
  discardStagedUpload,
  stageFile,
  type StagedFile,
  type UploadProgress,
} from "@/lib/files/upload-client";
import { formatFileSize } from "@/lib/utils";

/**
 * POST a chat message to the session, returning a discriminated union instead
 * of throwing HTTP details at the caller.
 *
 * Files are staged first, one chunk at a time, and the message carries their
 * ids: a large attachment reaches the agent without this request growing to the
 * size of the file.
 */

export type SendMessageResult =
  /** Accepted. `queued` means the session was busy (a generation running, or
   *  a compaction), so the message waits in the send queue instead of being
   *  prompted now. `steered` means the message was injected into a running
   *  turn that was waiting on a tool approval. all pending approvals were
   *  denied for it. */
  | { kind: "ok"; message: Message; queued: boolean; steered?: boolean; title?: string }
  /** 409. unexpected: the server queues instead of rejecting. */
  | { kind: "conflict" }
  /** 404. session gone; caller should navigate away. */
  | { kind: "not-found" }
  /** Any other failure, with a human-readable message. */
  | { kind: "error"; message: string };

export interface SendMessageOptions {
  signal?: AbortSignal;
  /** Bytes on their way up, or null when the staging is done. */
  onProgress?: (progress: UploadProgress | null) => void;
}

/** The ceiling for one attachment: images are re-encoded, everything else moves. */
function tooLarge(file: File): string | null {
  const ceiling = isImageMime(file.type) ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_FILE_BYTES;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > ceiling) {
    return `${file.name} is ${formatFileSize(file.size)}. Max: ${formatFileSize(ceiling)}`;
  }
  return null;
}

/** Drop staged bytes the message will not use. */
async function discardStaged(staged: StagedFile[]): Promise<void> {
  for (const file of staged) await discardStagedUpload("user", file.uploadId);
}

/** Stage every file in the user's workspace, reporting bytes as they land. */
async function stageAttachments(
  files: File[],
  options: SendMessageOptions,
): Promise<{ ok: true; staged: StagedFile[] } | { ok: false; message: string }> {
  const staged: StagedFile[] = [];

  try {
    for (const [position, file] of files.entries()) {
      const refusal = tooLarge(file);
      if (refusal) {
        await discardStaged(staged);
        return { ok: false, message: refusal };
      }

      const result = await stageFile(file, {
        target: "user",
        // The id is all a message needs; there is no destination folder.
        dir: "",
        batch: { index: position + 1, count: files.length },
        onProgress: options.onProgress ?? undefined,
        signal: options.signal,
      });
      if (!result.ok) {
        await discardStaged(staged);
        return { ok: false, message: result.message };
      }
      staged.push(result.staged);
    }
  } finally {
    options.onProgress?.(null);
  }

  return { ok: true, staged };
}

export async function sendChatMessage(
  sessionId: string,
  content: string,
  files?: File[],
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const url = `/api/chat/sessions/${sessionId}/messages`;

  let attachments: StagedFile[] = [];
  if (files && files.length > 0) {
    if (files.length > MAX_CHAT_ATTACHMENTS) {
      return {
        kind: "error",
        message: `Attach at most ${MAX_CHAT_ATTACHMENTS} files at a time`,
      };
    }
    const staging = await stageAttachments(files, options);
    if (!staging.ok) return { kind: "error", message: staging.message };
    attachments = staging.staged;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attachments.length > 0 ? { content, attachments } : { content }),
    signal: options.signal ?? null,
  });

  if (!res.ok) {
    // Nothing adopted the staged files, so they would sit in the scratch
    // directory until it is emptied.
    await discardStaged(attachments);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) return { kind: "not-found" };
    if (res.status === 409) return { kind: "conflict" };
    return { kind: "error", message: body.error || res.statusText };
  }

  const data = (await res.json()) as {
    message?: Message;
    queued?: boolean;
    steered?: boolean;
    title?: string;
  };
  if (!data.message) {
    return { kind: "error", message: "Missing message in response" };
  }
  return {
    kind: "ok",
    message: data.message,
    queued: data.queued === true,
    steered: data.steered === true,
    // the chat's title after this message, when the server (re)named it
    ...(data.title ? { title: data.title } : {}),
  };
}
