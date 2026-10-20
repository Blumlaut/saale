import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireMemoryOwner, requireSession } from "@/lib/auth";
import { deleteMemory, serializeMemory, updateMemory } from "@/lib/memory/store";

/**
 * GET /api/memories/[id]. Get a single memory
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireMemoryOwner(id);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ memory: serializeMemory(authResult.memory) });
}

/**
 * PATCH /api/memories/[id]. Update a memory
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const memory = await updateMemory(authResult.user.id, id, body);
  if (!memory) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  return NextResponse.json({ memory: serializeMemory(memory) });
}

/**
 * DELETE /api/memories/[id]. Delete a memory
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const deleted = await deleteMemory(authResult.user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
