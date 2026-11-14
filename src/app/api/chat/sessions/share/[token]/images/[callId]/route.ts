import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { DEFAULT_SHARE_ACCESS } from "@/lib/chat/share-access";
import { extractToolMetaBlock } from "@/lib/chat/tool-meta";
import { prisma } from "@/lib/db";
import { readWorkspaceFile } from "@/lib/files/workspace-file";

/** The tools whose picture a share page may show. */
const IMAGE_TOOLS = new Set(["generate_image", "edit_image"]);

/** Where the agent writes what it renders, relative to the workspace root. */
const GENERATED_DIR = "generated";

/**
 * GET /api/chat/sessions/share/:token/images/:callId. One rendered picture of a
 * shared chat.
 *
 * A share page cannot read the owner's workspace, so the bytes are served here
 * against the token, and only for a picture that call produced: the path comes
 * from the stored result of a tool call in *this* session, never from the
 * request. Nothing else in the workspace is reachable through this route.
 *
 * The access rule is the chat's own: a public token answers anyone holding it, a
 * gated one only a signed-in viewer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; callId: string }> },
) {
  const { token, callId } = await params;

  const session = await prisma.chatSession.findFirst({
    where: { shareToken: token, shared: true },
    select: { id: true, userId: true, shareAccess: true },
  });
  if (!session) return notFound();

  if (session.shareAccess !== DEFAULT_SHARE_ACCESS) {
    const viewer = await getSession();
    if (!viewer?.user?.id) {
      return NextResponse.json({ error: "Sign in to view this chat" }, { status: 401 });
    }
  }

  // A call id only appears in the message that made it, so this narrows to one
  // row without reading the whole transcript.
  const message = await prisma.chatMessage.findFirst({
    where: { sessionId: session.id, toolCalls: { contains: callId } },
    select: { toolCalls: true },
  });
  if (!message?.toolCalls) return notFound();

  const path = imagePathOf(message.toolCalls, callId);
  if (!path) return notFound();

  try {
    const file = await readWorkspaceFile(session.userId, path);
    return new NextResponse(file.buffer, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.size),
        // Unsharing has to take the picture away with it.
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    // A shared chat whose workspace is gone is a 404, not a broken page.
    console.error(`Failed to read the shared image ${path}:`, err);
    return notFound();
  }
}

/** The picture a call rendered, if that call is one of the image tools. */
function imagePathOf(toolCallsJson: string, callId: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch (err) {
    console.error("Failed to parse a shared chat's tool calls:", err);
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const call = parsed.find(
    (entry): entry is { id?: unknown; name?: unknown; result?: unknown } =>
      typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === callId,
  );
  if (!call || typeof call.name !== "string" || !IMAGE_TOOLS.has(call.name)) return undefined;

  const path = extractToolMetaBlock(typeof call.result === "string" ? call.result : undefined)?.meta
    .path;
  if (typeof path !== "string" || !path.startsWith(`${GENERATED_DIR}/`)) return undefined;
  return path;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
