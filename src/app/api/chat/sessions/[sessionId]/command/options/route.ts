import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { getCommandMeta } from "@/lib/commands/catalog";
import { COMMAND_HANDLERS } from "@/lib/commands/handlers";
import type { CommandName } from "@/lib/commands/catalog";
import type { CommandOptions } from "@/lib/commands/types";

/**
 * GET /api/chat/sessions/:sessionId/command/options?name=image. the values a
 * command's arguments accept, for the arguments only the server can list.
 *
 * The composer cannot know a model's resolutions from the catalog, so it asks
 * here while the user is filling a `size:` in. Everything else (a fixed list
 * of options, a boolean) it offers by itself.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const name = request.nextUrl.searchParams.get("name")?.toLowerCase() ?? "";
  const meta = getCommandMeta(name);
  if (!meta) {
    return NextResponse.json({ error: `Unknown command: /${name}` }, { status: 400 });
  }

  const handler = COMMAND_HANDLERS[meta.name as CommandName];
  if (!handler.options) return NextResponse.json({ options: {} });

  try {
    const options: CommandOptions = await handler.options({
      surface: "web",
      userId: authResult.userId,
      sessionId,
      args: "",
      files: [],
      arguments: {},
    });
    return NextResponse.json({ options });
  } catch (err) {
    console.error(`Failed to list the options of /${name}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The options could not be listed." },
      { status: 500 },
    );
  }
}
