import type { Message } from "@/components/chat/types";

/**
 * POST a chat message to the session, returning a discriminated union instead
 * of throwing HTTP details at the caller. Handles both plain-text (JSON) and
 * image-attachment (multipart) payloads.
 */

export type SendMessageResult =
  /** Accepted. `queued` means a generation was already running, so the
   *  message is waiting in the send queue instead of being prompted now. */
  | { kind: "ok"; message: Message; queued: boolean }
  /** 409 — unexpected: the server queues instead of rejecting. */
  | { kind: "conflict" }
  /** 404 — session gone; caller should navigate away. */
  | { kind: "not-found" }
  /** Any other failure, with a human-readable message. */
  | { kind: "error"; message: string };

export async function sendChatMessage(
  sessionId: string,
  content: string,
  files?: File[],
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  const url = `/api/chat/sessions/${sessionId}/messages`;

  let res: Response;
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("content", content);
    for (const file of files) {
      formData.append("files", file);
    }
    res = await fetch(url, { method: "POST", body: formData, signal: signal ?? null });
  } else {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: signal ?? null,
    });
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) return { kind: "not-found" };
    if (res.status === 409) return { kind: "conflict" };
    return { kind: "error", message: body.error || res.statusText };
  }

  const data = (await res.json()) as { message?: Message; queued?: boolean };
  if (!data.message) {
    return { kind: "error", message: "Missing message in response" };
  }
  return { kind: "ok", message: data.message, queued: data.queued === true };
}
