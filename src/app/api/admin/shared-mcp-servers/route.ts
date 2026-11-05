import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createMcpServer, INSTANCE_MCP_SERVERS, listMcpServers } from "@/lib/mcp/store";
import { toMcpServerView } from "@/lib/mcp/shared";

/**
 * GET /api/admin/shared-mcp-servers. the MCP servers every account connects.
 *
 * The `settings` slice covers this page: shared resources are instance settings,
 * not a grant of their own.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const servers = await listMcpServers(INSTANCE_MCP_SERVERS);
  return NextResponse.json({
    servers: servers.map((server) => toMcpServerView(server, { shared: true })),
  });
}

/**
 * POST /api/admin/shared-mcp-servers. add a server for every account.
 *
 * A change rebuilds every pooled chat, since the server was in all of them.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const result = await createMcpServer(INSTANCE_MCP_SERVERS, await request.json());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(
    { server: toMcpServerView(result.server, { shared: true }) },
    { status: 201 },
  );
}
