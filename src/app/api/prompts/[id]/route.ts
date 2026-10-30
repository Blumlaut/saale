import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  deletePrompt,
  normalizePromptInput,
  serializePrompt,
  updatePrompt,
} from "@/lib/prompts/store";

/** PATCH /api/prompts/[id]. Replace a prompt the user owns. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const input = normalizePromptInput(await request.json());
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updatePrompt(authResult.user.id, id, input.value);
  if (!result) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  return NextResponse.json({ prompt: serializePrompt(result.prompt) });
}

/** DELETE /api/prompts/[id]. Delete a prompt the user owns. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const deleted = await deletePrompt(authResult.user.id, id);
  if (!deleted) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  return NextResponse.json({ success: true });
}
