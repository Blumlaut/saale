import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { generateSshKeyPair } from "@/lib/infra/client";

/**
 * GET /api/infra/machines. List user's infrastructure machines
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const machines = await prisma.infraMachine.findMany({
    where: { userId: authResult.user.id },
    orderBy: { name: "asc" },
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

  return NextResponse.json({
    machines: machines.map((m) => ({
      id: m.id,
      name: m.name,
      host: m.host,
      port: m.port,
      username: m.username,
      authMethod: m.authMethod,
      noteCount: m._count.notes,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/infra/machines. Register a new machine
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { name, host, port, username, authMethod, password } = body;

  if (!name || !host || !username || !authMethod) {
    return NextResponse.json(
      { error: "Missing required fields: name, host, username, authMethod" },
      { status: 400 },
    );
  }

  if (authMethod === "password" && !password) {
    return NextResponse.json(
      { error: "password is required when authMethod='password'" },
      { status: 400 },
    );
  }

  try {
    let authorizedKeysEntry: string | undefined;

    const machine = await prisma.infraMachine.create({
      data: {
        userId: authResult.user.id,
        name,
        host,
        port: port ?? 22,
        username,
        authMethod,
        ...(authMethod === "key"
          ? (() => {
              const { privateKey, publicKey } = generateSshKeyPair();
              authorizedKeysEntry = publicKey;
              return { encryptedKey: encrypt(privateKey) };
            })()
          : {}),
        ...(authMethod === "password" && password ? { encryptedPass: encrypt(password) } : {}),
      },
    });

    const response: Record<string, unknown> = {
      machine: {
        id: machine.id,
        name: machine.name,
        host: machine.host,
        port: machine.port,
        username: machine.username,
        authMethod: machine.authMethod,
        createdAt: machine.createdAt.toISOString(),
      },
    };

    if (authMethod === "key" && authorizedKeysEntry) {
      response.authorizedKeysEntry = authorizedKeysEntry;
    }

    return NextResponse.json(response);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint failed")) {
      return NextResponse.json(
        { error: "A machine with this name already exists" },
        { status: 409 },
      );
    }
    console.error("Failed to create infra machine:", err);
    return NextResponse.json({ error: "Failed to create machine" }, { status: 500 });
  }
}
