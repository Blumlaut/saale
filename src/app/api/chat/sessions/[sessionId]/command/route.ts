import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { requireChatSessionOwner } from "@/lib/auth";
import { executeCommand } from "@/lib/commands/execute";
import { getCommandMeta } from "@/lib/commands/catalog";
import { takesFiles } from "@/lib/commands/arguments";
import { chatCommandSchema } from "@/lib/chat/schema";
import {
  adoptChatUpload,
  validateChatAttachment,
  type AdoptedChatFile,
} from "@/lib/file-attachment";
import { FileNotFoundError, FileUploadError } from "@/lib/files/errors";
import type { CommandFile } from "@/lib/commands/types";

/**
 * POST /api/chat/sessions/:sessionId/command. run a slash command.
 *
 * The web chat's only command entrypoint: the composer intercepts a leading
 * `/name`, posts it here, and renders whatever comes back. a prompt (the
 * command needs a choice) or an outcome. Telegram reaches the same
 * `executeCommand` through its own adapter, so a command is implemented once.
 *
 * Body: `{ name: string, args?: string, value?: string, attachments?: [...] }`.
 * Attachments are chunked uploads the composer staged, the same ones a message
 * carries: a command that works from files (`/edit`) reaches them through
 * `ctx.files`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, chatCommandSchema);
  if (!body.ok) return body.response;

  const meta = getCommandMeta(body.data.name);
  if (!meta) {
    return NextResponse.json({ error: `Unknown command: /${body.data.name}` }, { status: 400 });
  }
  if ((body.data.attachments?.length ?? 0) > 0 && !takesFiles(meta)) {
    return NextResponse.json({ error: `/${meta.name} does not take files` }, { status: 400 });
  }

  const files: CommandFile[] = [];
  for (const ref of body.data.attachments ?? []) {
    const error = validateChatAttachment(ref);
    if (error) return NextResponse.json({ error }, { status: 400 });

    let adopted: AdoptedChatFile;
    try {
      adopted = await adoptChatUpload(authResult.userId, ref);
    } catch (err) {
      // A staged upload that is gone or short is the composer's mistake to fix
      // by sending the file again, not a server fault.
      if (err instanceof FileNotFoundError || err instanceof FileUploadError) {
        return NextResponse.json({ error: `${ref.fileName}: ${err.message}` }, { status: 400 });
      }
      throw err;
    }

    files.push({
      path: adopted.agentPath,
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      size: ref.size,
    });
  }

  const result = await executeCommand(
    body.data.name,
    {
      surface: "web",
      userId: authResult.userId,
      sessionId,
      args: body.data.args ?? "",
      files,
    },
    body.data.value,
  );

  if (result.kind === "error") {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
