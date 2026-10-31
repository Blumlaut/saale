/**
 * Which computer a chat was started from.
 *
 * The desktop agent's window sets `CLIENT_DEVICE_COOKIE` on this origin with its
 * own device id. A chat created from that window remembers it, and its agent may
 * then reach that machine. Everywhere else — a plain browser, a phone, Telegram —
 * the cookie is absent and the chat gets no computer.
 *
 * The id is checked against the caller's own devices here, at the point it is
 * stored, and again when the session is built.
 */

import type { NextRequest } from "next/server";
import { CLIENT_DEVICE_COOKIE } from "./shared";
import { getChatDevice } from "./store";

/** The device id to remember on a new chat, or null. */
export async function resolveClientDevice(
  userId: string,
  request: NextRequest,
): Promise<string | null> {
  const raw = request.cookies.get(CLIENT_DEVICE_COOKIE)?.value?.trim();
  if (!raw) return null;

  const device = await getChatDevice(userId, raw);
  return device?.id ?? null;
}
