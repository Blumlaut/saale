import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createMcpServer, userMcpServers } from "@/lib/mcp/store";
import { parseMcpConfig, type SkippedMcpServer } from "@/lib/mcp/import-config";
import { toMcpServerView } from "@/lib/mcp/shared";

/**
 * POST /api/mcp/servers/import. add the servers of a config pasted from another
 * client.
 *
 * Each entry is created the way the sheet creates one, so a pasted config is
 * validated, sealed and evicted exactly like a typed one. An entry that cannot
 * be stored is reported back with its reason and the rest still land.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const config = typeof body.config === "string" ? body.config : "";
  const parsed = parseMcpConfig(config);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owner = userMcpServers(authResult.user.id);
  const created: ReturnType<typeof toMcpServerView>[] = [];
  const skipped: SkippedMcpServer[] = [...parsed.value.skipped];

  for (const server of parsed.value.servers) {
    const result = await createMcpServer(owner, {
      name: server.name,
      transport: server.transport,
      url: server.url ?? undefined,
      command: server.command ?? undefined,
      cwd: server.cwd ?? undefined,
      env: server.env,
      token: server.token ?? undefined,
      description: server.description,
    });

    if (!result.ok) {
      skipped.push({ name: server.name, error: result.error });
      continue;
    }
    created.push(toMcpServerView(result.server));
  }

  return NextResponse.json({ created, skipped }, { status: created.length > 0 ? 201 : 200 });
}
