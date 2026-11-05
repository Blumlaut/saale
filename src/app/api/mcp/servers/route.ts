import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadMcpOAuthCredentialIds } from "@/lib/mcp/oauth";
import {
  createMcpServer,
  INSTANCE_MCP_SERVERS,
  listMcpServers,
  userMcpServers,
} from "@/lib/mcp/store";
import { mcpNameKey, toMcpServerView } from "@/lib/mcp/shared";
import { mergeOwnedRows } from "@/lib/shared-resources";

/**
 * GET /api/mcp/servers. the servers this account connects: the instance's
 * shared ones, then the user's own.
 *
 * A shared server is listed read-only (`shared: true`): the user can see what
 * the workspace offers but cannot edit or remove it.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const [own, shared] = await Promise.all([
    listMcpServers(userMcpServers(userId)),
    listMcpServers(INSTANCE_MCP_SERVERS),
  ]);

  const oauthIds = await loadMcpOAuthCredentialIds(
    userId,
    own.map((server) => server.id),
  );

  const servers = mergeOwnedRows({ own, shared, keyOf: (server) => mcpNameKey(server.name) }).map(
    ({ shared: isShared, ...server }) =>
      toMcpServerView(server, {
        hasOAuth: !isShared && oauthIds.has(server.id),
        shared: isShared,
      }),
  );

  return NextResponse.json({ servers });
}

/**
 * POST /api/mcp/servers. add a server.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const result = await createMcpServer(userMcpServers(authResult.user.id), await request.json());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ server: toMcpServerView(result.server) }, { status: 201 });
}
