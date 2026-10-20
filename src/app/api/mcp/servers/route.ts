import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { loadMcpOAuthCredentialIds } from "@/lib/mcp/oauth";
import { evictUserSessions } from "@/lib/pi/agent-pool";
import {
  isMcpToolPolicy,
  mcpNameKey,
  toMcpServerView,
  validateMcpServerName,
  validateMcpUrl,
} from "@/lib/mcp/shared";

/**
 * GET /api/mcp/servers. the user's configured MCP servers.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const servers = await prisma.mcpServer.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "asc" },
  });

  const oauthIds = await loadMcpOAuthCredentialIds(
    authResult.user.id,
    servers.map((server) => server.id),
  );

  return NextResponse.json({
    servers: servers.map((server) => toMcpServerView(server, oauthIds.has(server.id))),
  });
}

/**
 * POST /api/mcp/servers. add a server.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const body = (await request.json()) as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const toolPolicy = body.toolPolicy;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

  const nameError = validateMcpServerName(name);
  if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

  const urlError = validateMcpUrl(url);
  if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });

  if (toolPolicy !== undefined && !isMcpToolPolicy(toolPolicy)) {
    return NextResponse.json({ error: "Unknown approval setting." }, { status: 400 });
  }

  // Pi turns a server name into tool names and treats `-` and `_` as the same
  // character, so `home-assistant` and `home_assistant` are one server.
  const existing = await prisma.mcpServer.findMany({
    where: { userId },
    select: { name: true },
  });
  if (existing.some((server) => mcpNameKey(server.name) === mcpNameKey(name))) {
    return NextResponse.json(
      { error: `A server named "${name}" is already configured.` },
      { status: 409 },
    );
  }

  const server = await prisma.mcpServer.create({
    data: {
      userId,
      name,
      url,
      description,
      toolPolicy: isMcpToolPolicy(toolPolicy) ? toolPolicy : "ask",
      enabled,
      ...(token ? { encryptedToken: encrypt(token) } : {}),
    },
  });

  // Pooled chats were built against the previous server list.
  await evictUserSessions(userId);

  return NextResponse.json({ server: toMcpServerView(server) }, { status: 201 });
}
