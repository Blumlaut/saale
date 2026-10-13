import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  clearMcpOAuthCredential,
  clearMcpOAuthFlow,
  hasMcpOAuthCredential,
  readMcpOAuthFlow,
} from "@/lib/mcp/oauth";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/** Status a server with no sign-in in progress reports. */
const IDLE = "idle";

/**
 * GET /api/mcp/servers/:serverId/oauth — the state of this server's sign-in,
 * which the settings sheet polls while the user is in the browser.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [flow, hasOAuth] = await Promise.all([
    readMcpOAuthFlow(userId, serverId),
    hasMcpOAuthCredential(userId, serverId),
  ]);

  return NextResponse.json({
    status: flow?.status ?? IDLE,
    error: flow?.error ?? null,
    authorizationUrl: flow?.authorizationUrl ?? null,
    hasOAuth,
  });
}

/**
 * DELETE /api/mcp/servers/:serverId/oauth — sign out. Drops the stored
 * credentials and the browser state, so the next connection asks for a fresh
 * sign-in.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await clearMcpOAuthCredential(userId, serverId);
  await clearMcpOAuthFlow(serverId);
  await evictUserSessions(userId);

  return NextResponse.json({ ok: true });
}
