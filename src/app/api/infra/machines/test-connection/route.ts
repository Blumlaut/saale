import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { testConnection } from "@/lib/infra/client";

/**
 * POST /api/infra/machines/test-connection — Test SSH connectivity
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "Machine ID is required" }, { status: 400 });
  }

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true, name: true },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  try {
    const result = await testConnection(id, authResult.user.id);

    return NextResponse.json({
      ok: result.ok,
      message: result.message,
      hostname: result.hostname ?? null,
    });
  } catch (err) {
    console.error("SSH connection test failed:", err);
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : "Connection test failed",
    });
  }
}
