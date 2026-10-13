import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cacheMcpOAuthChallenge, createMcpAuthProvider } from "@/lib/mcp/oauth";
import { describeProbeError, isMcpOAuthRequired, probeMcpServer } from "@/lib/mcp/probe";
import { readMcpToken } from "@/lib/mcp/servers";
import { validateMcpUrl } from "@/lib/mcp/shared";

/**
 * POST /api/mcp/servers/:serverId/test — connect to a server and list its tools.
 *
 * `serverId` may be `new`, which tests the URL and token in the request body
 * before anything is stored. For a stored server the saved token is used
 * unless the body overrides it, so an edit can be verified before saving. A
 * stored server with no bearer token is tested through its OAuth credentials;
 * without any, the 401 tells the settings page to offer a sign-in.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  let url = typeof body.url === "string" ? body.url.trim() : "";
  let token: string | null = typeof body.token === "string" ? body.token.trim() || null : null;
  let authProvider: AuthProvider | undefined;

  if (serverId !== "new") {
    const server = await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
    if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!url) url = server.url;
    // Only fall back to the stored token when the body did not supply one.
    if (!token && typeof body.token !== "string") token = readMcpToken(server);

    // A server configured for OAuth has no bearer token: test the stored
    // sign-in, or let the 401 report that a sign-in is needed.
    if (!token && server.encryptedToken === null) {
      authProvider = createMcpAuthProvider({
        id: server.id,
        userId,
        name: server.name,
        url,
      });
    }
  }

  const urlError = validateMcpUrl(url);
  if (urlError) return NextResponse.json({ success: false, error: urlError }, { status: 400 });

  try {
    const result = await probeMcpServer({
      url,
      token,
      ...(authProvider ? { authProvider } : {}),
    });
    return NextResponse.json({
      success: true,
      serverName: result.serverName,
      serverVersion: result.serverVersion,
      instructions: result.instructions,
      tools: result.tools,
    });
  } catch (err) {
    console.error(`MCP connection test failed for user ${userId} (${url}):`, err);
    const needsAuth = isMcpOAuthRequired(err);
    if (needsAuth && serverId !== "new") await cacheMcpOAuthChallenge(serverId, err);
    return NextResponse.json(
      { success: false, error: describeProbeError(err), needsAuth },
      { status: 502 },
    );
  }
}
