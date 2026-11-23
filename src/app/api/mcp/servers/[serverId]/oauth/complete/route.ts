import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { completeMcpOAuthSignInFromUrl, markMcpOAuthSignInSucceeded } from "@/lib/mcp/oauth";
import { describeMcpSignInError } from "@/lib/mcp/oauth-errors";
import { getRequestPublicUrl } from "@/lib/public-url";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/**
 * POST /api/mcp/servers/:serverId/oauth/complete. finish a sign-in whose redirect
 * the browser could not deliver, from the address it ended on.
 *
 * A server that refuses a public callback signs in over loopback, which no
 * browser can reach: the code sits in the address bar of the page that failed to
 * load, and the user pastes it here. The `state` in that address must match the
 * one this sign-in stored.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as { url?: unknown };
  const pasted = typeof body.url === "string" ? body.url.trim() : "";
  if (!pasted) {
    return NextResponse.json({ error: "Paste the address the browser ended on." }, { status: 400 });
  }

  const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!server.url) {
    return NextResponse.json(
      { error: "This server runs a command, so it has no sign-in to finish." },
      { status: 400 },
    );
  }

  try {
    await completeMcpOAuthSignInFromUrl(
      { id: server.id, userId, name: server.name, url: server.url },
      pasted,
      { baseUrl: getRequestPublicUrl(request) },
    );
    await markMcpOAuthSignInSucceeded(userId, server.id);
    // The server's tools become available on the next session.
    await evictUserSessions(userId);
    return NextResponse.json({ status: "succeeded" });
  } catch (err) {
    console.error(`Failed to finish the MCP OAuth sign-in for server ${serverId}:`, err);
    const problem = describeMcpSignInError(err);
    return NextResponse.json({ error: problem.message }, { status: problem.status });
  }
}
