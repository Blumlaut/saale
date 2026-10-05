import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { evictUserSessions } from "@/lib/pi/agent-pool";
import {
  isMcpToolPolicy,
  mcpNameKey,
  toMcpServerView,
  validateMcpServerName,
  validateMcpUrl,
} from "@/lib/mcp/shared";

/** Look up a server the caller owns. */
async function findOwnedServer(userId: string, serverId: string) {
  return prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
}

/**
 * PATCH /api/mcp/servers/:serverId — update a server.
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
  const userId = authResult.user.id;

  const { serverId } = await params;
  const existing = await findOwnedServer(userId, serverId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const nameError = validateMcpServerName(name);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

    const others = await prisma.mcpServer.findMany({
      where: { userId, id: { not: serverId } },
      select: { name: true },
    });
    if (others.some((server) => mcpNameKey(server.name) === mcpNameKey(name))) {
      return NextResponse.json(
        { error: `A server named "${name}" is already configured.` },
        { status: 409 },
      );
    }
    data.name = name;
  }

  if (body.url !== undefined) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const urlError = validateMcpUrl(url);
    if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });
    data.url = url;
  }

  if (body.description !== undefined) {
    data.description = typeof body.description === "string" ? body.description.trim() : "";
  }

  if (body.toolPolicy !== undefined) {
    if (!isMcpToolPolicy(body.toolPolicy)) {
      return NextResponse.json({ error: "Unknown approval setting." }, { status: 400 });
    }
    data.toolPolicy = body.toolPolicy;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    data.enabled = body.enabled;
  }

  if (body.token !== undefined) {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    data.encryptedToken = token ? encrypt(token) : null;
  }

  const server = await prisma.mcpServer.update({ where: { id: serverId, userId }, data });

  await evictUserSessions(userId);

  return NextResponse.json({ server: toMcpServerView(server) });
}

/**
 * DELETE /api/mcp/servers/:serverId — remove a server.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;

  const deleted = await prisma.mcpServer.deleteMany({ where: { id: serverId, userId } });
  if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await evictUserSessions(userId);

  return NextResponse.json({ ok: true });
}
