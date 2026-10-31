/**
 * Which computer a chat may reach.
 *
 * The newest user message decides. A message sent from a client that claims a
 * computer lets the agent use that machine; a message from anywhere else — a
 * plain browser tab, a phone, Telegram — takes that away, and a tool call made
 * after such a message is refused. Nothing is sticky: control is re-read at the
 * start of every run and again on every device tool call.
 */

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { CLIENT_DEVICE_COOKIE } from "./shared";
import { getChatDevice } from "./store";

/** The device a request's cookie claims, when it is one of this user's. */
export async function resolveClientDevice(
  userId: string,
  request: NextRequest,
): Promise<string | null> {
  const raw = request.cookies.get(CLIENT_DEVICE_COOKIE)?.value?.trim();
  if (!raw) return null;

  const device = await getChatDevice(userId, raw);
  return device?.id ?? null;
}

/**
 * The computer the chat's newest user message came from, or null.
 *
 * Read fresh on every check, which is what makes a message from another client
 * revoke access immediately rather than at the next turn.
 */
export async function resolveChatDeviceId(
  userId: string,
  sessionId: string,
): Promise<string | null> {
  const newest = await prisma.chatMessage.findFirst({
    where: { sessionId, role: "user", session: { userId } },
    orderBy: { createdAt: "desc" },
    select: { clientDeviceId: true },
  });

  if (!newest?.clientDeviceId) return null;

  // A device that was disconnected since that message no longer counts.
  const device = await getChatDevice(userId, newest.clientDeviceId);
  return device?.id ?? null;
}
