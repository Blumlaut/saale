import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  createPrompt,
  INSTANCE_PROMPTS,
  listPrompts,
  normalizePromptInput,
  serializePrompt,
  userPrompts,
} from "@/lib/prompts/store";
import { mergeOwnedRows } from "@/lib/shared-resources";

/**
 * GET /api/prompts. The account's prompts, then the instance's, by name.
 *
 * A shared prompt is listed read-only (`shared: true`). One the account's own
 * prompt shadows by name is left out: the `/` menu offers one prompt per name,
 * and it is the account's.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const owner = userPrompts(authResult.user.id);

  const [own, shared] = await Promise.all([listPrompts(owner), listPrompts(INSTANCE_PROMPTS)]);
  const prompts = mergeOwnedRows({ own, shared }).map(({ shared: isShared, ...prompt }) => ({
    ...serializePrompt(prompt),
    shared: isShared,
  }));

  return NextResponse.json({ prompts });
}

/** POST /api/prompts. Create a prompt for the signed-in user. */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const input = normalizePromptInput(await request.json());
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await createPrompt(userPrompts(authResult.user.id), input.value);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  return NextResponse.json({ prompt: serializePrompt(result.prompt) });
}
