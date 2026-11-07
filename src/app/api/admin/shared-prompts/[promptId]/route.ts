import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import {
  deletePrompt,
  INSTANCE_PROMPTS,
  normalizePromptInput,
  serializePrompt,
  updatePrompt,
} from "@/lib/prompts/store";

/** PATCH /api/admin/shared-prompts/:promptId. Replace a prompt every account gets. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ promptId: string }> },
) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const { promptId } = await params;
  const input = normalizePromptInput(await request.json());
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await updatePrompt(INSTANCE_PROMPTS, promptId, input.value);
  if (!result) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  return NextResponse.json({ prompt: serializePrompt(result.prompt) });
}

/** DELETE /api/admin/shared-prompts/:promptId. Remove a shared prompt. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ promptId: string }> },
) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const { promptId } = await params;
  const deleted = await deletePrompt(INSTANCE_PROMPTS, promptId);
  if (!deleted) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  return NextResponse.json({ success: true });
}
