import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

/**
 * GET /api/infra/machines/[id]. Get a single machine
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
    select: {
      id: true,
      name: true,
      host: true,
      port: true,
      username: true,
      authMethod: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { notes: true } },
    },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  return NextResponse.json({
    machine: {
      id: machine.id,
      name: machine.name,
      host: machine.host,
      port: machine.port,
      username: machine.username,
      authMethod: machine.authMethod,
      noteCount: machine._count.notes,
      createdAt: machine.createdAt.toISOString(),
      updatedAt: machine.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/infra/machines/[id]. Update a machine
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) updateData.name = body.name;
  if (body.host !== undefined) updateData.host = body.host;
  if (body.port !== undefined) updateData.port = body.port;
  if (body.username !== undefined) updateData.username = body.username;

  if (body.authMethod !== undefined) {
    updateData.authMethod = body.authMethod;
    if (body.authMethod === "key" && body.privateKey) {
      updateData.encryptedKey = encrypt(body.privateKey);
    }
    if (body.authMethod === "password" && body.password) {
      updateData.encryptedPass = encrypt(body.password);
    }
  } else {
    // Keep existing auth method. only update credential if provided
    if (machine.authMethod === "key" && body.privateKey) {
      updateData.encryptedKey = encrypt(body.privateKey);
    }
    if (machine.authMethod === "password" && body.password) {
      updateData.encryptedPass = encrypt(body.password);
    }
  }

  if (body.passPhrase !== undefined) {
    updateData.passPhrase = body.passPhrase ? encrypt(body.passPhrase) : null;
  }

  try {
    const updated = await prisma.infraMachine.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      machine: {
        id: updated.id,
        name: updated.name,
        host: updated.host,
        port: updated.port,
        username: updated.username,
        authMethod: updated.authMethod,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint failed")) {
      return NextResponse.json(
        { error: "A machine with this name already exists" },
        { status: 409 },
      );
    }
    console.error("Failed to update infra machine:", err);
    return NextResponse.json({ error: "Failed to update machine" }, { status: 500 });
  }
}

/**
 * DELETE /api/infra/machines/[id]. Remove a machine and its notes
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  await prisma.infraMachine.delete({ where: { id } });

  return NextResponse.json({ removed: true, id, name: machine.name });
}
