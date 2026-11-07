import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import {
  createPrompt,
  INSTANCE_PROMPTS,
  listPrompts,
  normalizePromptInput,
  serializePrompt,
} from "@/lib/prompts/store";

/**
 * GET /api/admin/shared-prompts. the prompts every account gets.
 *
 * The `settings` slice covers this page: shared resources are instance
 * settings, not a grant of their own.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const prompts = await listPrompts(INSTANCE_PROMPTS);
  return NextResponse.json({ prompts: prompts.map(serializePrompt) });
}

/** POST /api/admin/shared-prompts. Create a prompt for every account. */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const input = normalizePromptInput(await request.json());
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await createPrompt(INSTANCE_PROMPTS, input.value);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  return NextResponse.json({ prompt: serializePrompt(result.prompt) });
}
