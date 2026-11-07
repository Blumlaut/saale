import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { deleteMcpServer, updateMcpServer, userMcpServers } from "@/lib/mcp/store";
import { toMcpServerView } from "@/lib/mcp/shared";

/**
 * PATCH /api/mcp/servers/:serverId. update a server.
 *
 * An omitted field keeps its current value; `token: ""` clears the stored
 * token, any other string replaces it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { serverId } = await params;
  const result = await updateMcpServer(
    userMcpServers(authResult.user.id),
    serverId,
    await request.json(),
  );
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    server: toMcpServerView(result.server, { hasOAuth: result.hasOAuth }),
  });
}

/**
 * DELETE /api/mcp/servers/:serverId. remove a server.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { serverId } = await params;
  const deleted = await deleteMcpServer(userMcpServers(authResult.user.id), serverId);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
