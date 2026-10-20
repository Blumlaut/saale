import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startMcpOAuthSignIn } from "@/lib/mcp/oauth";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/**
 * POST /api/mcp/servers/:serverId/oauth/start. begin an OAuth sign-in.
 *
 * Returns the URL the user's browser must open, or `succeeded` when the stored
 * refresh token was still good and no browser is needed.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const result = await startMcpOAuthSignIn({
      id: server.id,
      userId,
      name: server.name,
      url: server.url,
    });

    // New credentials change what a pooled session authenticates with.
    if (result.status === "succeeded") await evictUserSessions(userId);

    return NextResponse.json(result);
  } catch (err) {
    console.error(`Failed to start the MCP OAuth sign-in for server ${serverId}:`, err);
    const message = err instanceof Error ? err.message : "Failed to start the sign-in";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
