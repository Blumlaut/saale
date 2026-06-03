import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveImagePath } from "@/lib/image-attachment";

/**
 * GET /api/chat/attachments/:id — Serve a stored image attachment.
 *
 * Authenticates the user, verifies ownership of the parent chat session,
 * and serves the file with appropriate caching headers.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  // Look up the attachment and verify ownership
  const attachment = await prisma.chatAttachment.findFirst({
    where: { storageId: id },
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

  if (attachment.message.session.userId !== authResult.user.id) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Resolve the user from the chat session (not the auth session — could differ if sharing)
  const userId = attachment.message.session.userId;

  try {
    const fullPath = resolveImagePath(userId, attachment.storagePath);
    const buffer = await fs.readFile(fullPath);

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Length": String(buffer.length),
      },
    });
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }
}
