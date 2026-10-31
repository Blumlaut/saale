/**
 * Who is calling the device endpoints.
 *
 * Two different callers reach `api/devices`: a signed-in browser managing its
 * computers, and an agent holding the token it was given at pairing. They never
 * share a route, and the token never authenticates anything else.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashDeviceToken, isDeviceToken } from "./tokens";

export interface AuthedDevice {
  id: string;
  userId: string;
  name: string;
  platform: string;
  session: string;
  capabilities: string[];
  agentVersion: string;
}

/** The bearer token on a request, when it is one of ours. */
export function readDeviceToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  return isDeviceToken(token) ? token : null;
}

/**
 * The device behind a request's token, or a 401.
 *
 * A revoked device answers like an unknown one: the row stays for the settings
 * page's history, and its token is dead either way.
 */
export async function authenticateDevice(
  request: NextRequest,
): Promise<{ ok: true; device: AuthedDevice } | { ok: false; response: NextResponse }> {
  const token = readDeviceToken(request);
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const device = await prisma.device.findFirst({
    where: { tokenHash: hashDeviceToken(token), revokedAt: null },
    select: {
      id: true,
      userId: true,
      name: true,
      platform: true,
      session: true,
      capabilities: true,
      agentVersion: true,
    },
  });

  if (!device) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return { ok: true, device };
}
