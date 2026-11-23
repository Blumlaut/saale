import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readCachedMcpTools } from "@/lib/mcp/tool-cache";

/**
 * GET /api/mcp/servers/:serverId/tools. the tools a server last answered with.
 *
 * The approval policy of one MCP tool is stored against its name, so the
 * settings page has to know the names before it can offer them. `tools: null`
 * means nothing has been looked up yet; a test of the server fills the list.
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

  return NextResponse.json({ tools: await readCachedMcpTools(serverId) });
}
