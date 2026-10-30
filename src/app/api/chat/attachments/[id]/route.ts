import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import fs from "fs/promises";
import { Readable } from "node:stream";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveImagePath } from "@/lib/image-attachment";

/**
 * GET /api/chat/attachments/:id. Serve a stored image attachment.
 *
 * Authenticates the user, verifies ownership of the parent chat session,
 * and serves the file with appropriate caching headers.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  // Look up the attachment and verify ownership via session
  const attachment = await prisma.chatAttachment.findFirst({
    where: {
      storageId: id,
      message: {
        session: {
          userId: authResult.user.id,
        },
      },
    },
    include: {
      message: {
        select: {
          session: {
            select: { userId: true },
          },
        },
      },
    },
  });

  if (!attachment) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Resolve the user from the chat session (not the auth session. could differ if sharing)
  const userId = attachment.message.session.userId;

  try {
    const fullPath = resolveImagePath(userId, attachment.storagePath);
    // Streamed: an attachment can be a snapshot of a gigabyte, and reading one
    // into a buffer to hand it back is an out-of-memory kill for the whole app.
    const stats = await fs.stat(fullPath);

    const headers: Record<string, string> = {
      "Content-Type": attachment.mimeType,
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Length": String(stats.size),
      // Attachments can be any file type the user uploaded. never let the
      // browser sniff the content into something executable.
      "X-Content-Type-Options": "nosniff",
    };

    // Non-images are downloads (avoids navigating away to a rendered file).
    if (!attachment.mimeType.startsWith("image/")) {
      headers["Content-Disposition"] = `attachment; filename="${attachment.fileName.replace(
        /["\\\r\n]/g,
        "_",
      )}"`;
    }

    const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, { headers });
  } catch (err) {
    console.error(`Failed to read attachment ${attachment.storageId}:`, err);
    return new NextResponse("File not found", { status: 404 });
  }
}
