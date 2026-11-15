import type { Message } from "@/components/chat/types";
import type { StagedFile, UploadProgress } from "@/lib/files/upload-client";
import { discardStaged, stageAttachments } from "./stage-attachments";

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

export async function sendChatMessage(
  sessionId: string,
  content: string,
  files?: File[],
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const url = `/api/chat/sessions/${sessionId}/messages`;

  let attachments: StagedFile[] = [];
  if (files && files.length > 0) {
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
