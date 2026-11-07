import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteMcpServer, INSTANCE_MCP_SERVERS, updateMcpServer } from "@/lib/mcp/store";
import { toMcpServerView } from "@/lib/mcp/shared";

/** PATCH /api/admin/shared-mcp-servers/:serverId. update a server every account gets. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const { serverId } = await params;
  const result = await updateMcpServer(INSTANCE_MCP_SERVERS, serverId, await request.json());
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ server: toMcpServerView(result.server) });
}

/** DELETE /api/admin/shared-mcp-servers/:serverId. remove a shared server. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const { serverId } = await params;
  const deleted = await deleteMcpServer(INSTANCE_MCP_SERVERS, serverId);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
