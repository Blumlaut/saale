import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  createPrompt,
  listUserPrompts,
  normalizePromptInput,
  serializePrompt,
} from "@/lib/prompts/store";

/** GET /api/prompts. The user's prompts, by name. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const prompts = await listUserPrompts(authResult.user.id);
  return NextResponse.json({ prompts: prompts.map(serializePrompt) });
}

/** POST /api/prompts. Create a prompt for the signed-in user. */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const input = normalizePromptInput(await request.json());
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await createPrompt(authResult.user.id, input.value);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  return NextResponse.json({ prompt: serializePrompt(result.prompt) });
}
