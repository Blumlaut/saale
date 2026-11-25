import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireEmailMessageOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fetchMessageBody, syncMessageFlags, deleteMessage } from "@/lib/email/imap";
import { archiveFolder, folderTargetFrom, specialFolder } from "@/lib/email/folders";
import { fileMessage } from "@/lib/email/file-message";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";

/**
 * GET /api/email/messages/:messageId. Get a single email message (with body)
 * Fetches body from IMAP on-demand if not yet stored.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  const authResult = await requireEmailMessageOwner(messageId);
  if (!authResult.ok) return authResult.response;

  let message = authResult.message;

  // Fetch body on-demand if not yet stored
  if (!message.bodyHtml && !message.bodyText) {
    const body = await fetchMessageBody(messageId);
    if (body) {
      message = { ...message, ...body };
    }
  }

  return NextResponse.json({
    message: {
      id: message.id,
      uid: message.uid,
      fromName: message.fromName,
      fromEmail: message.fromEmail,
      to: message.to,
      subject: message.subject,
      date: message.date.toISOString(),
      bodyPreview: message.bodyPreview,
      bodyHtml: sanitizeEmailHtml(message.bodyHtml),
      bodyText: message.bodyText,
      isRead: message.isRead,
      isStarred: message.isStarred,
      folder: message.folder,
      tags: message.tags,
      accountId: message.accountId,
    },
  });
}

/**
 * PATCH /api/email/messages/:messageId. Update message fields (star, read, tags)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  const authResult = await requireEmailMessageOwner(messageId);
  if (!authResult.ok) return authResult.response;
  const message = authResult.message;

  const body = await request.json();

  // ── Trash action ──────────────────────────────────────────────
  if (body.action === "trash") {
    const account = await prisma.emailAccount.findUnique({
      where: { id: message.accountId },
      select: { specialFolders: true, cachedFolders: true },
    });
    const trashFolder = specialFolder(folderTargetFrom(account ?? {}), "\\Trash");

    // No trash folder to wait in, or the message already waits there: emptying
    // it is what the click means.
    if (!trashFolder || trashFolder === message.folder) {
      deleteMessage(message.accountId, message.folder, message.uid).catch(() => {
        // Already logged inside deleteMessage
      });
      await prisma.emailMessage.delete({ where: { id: messageId } });
      return NextResponse.json({ trashed: true, folder: trashFolder });
    }

    const { moved } = await fileMessage({ message, destination: trashFolder });
    if (!moved) {
      return NextResponse.json(
        { error: "The mail server did not move the message to its trash folder" },
        { status: 502 },
      );
    }

    return NextResponse.json({ trashed: true, folder: trashFolder });
  }

  // ── Archive action ────────────────────────────────────────────
  if (body.action === "archive") {
    const account = await prisma.emailAccount.findUnique({
      where: { id: message.accountId },
      select: { specialFolders: true, cachedFolders: true },
    });
    const destination = archiveFolder(folderTargetFrom(account ?? {}));

    if (!destination) {
      return NextResponse.json(
        { error: "This account has no archive folder on its mail server" },
        { status: 409 },
      );
    }

    const { moved } = await fileMessage({ message, destination });
    if (!moved) {
      return NextResponse.json(
        { error: "The mail server did not move the message to its archive folder" },
        { status: 502 },
      );
    }

    return NextResponse.json({ archived: true, folder: destination });
  }

  // ── Standard field updates ────────────────────────────────────
  const updateData: Record<string, unknown> = {};

  if (body.isStarred !== undefined) {
    updateData.isStarred = body.isStarred;
  }
  if (body.isRead !== undefined) {
    updateData.isRead = body.isRead;
  }
  if (body.tags !== undefined && Array.isArray(body.tags)) {
    updateData.tags = body.tags;
  }

  const updated = await prisma.emailMessage.update({
    where: { id: messageId },
    data: updateData,
    select: {
      id: true,
      uid: true,
      folder: true,
      isStarred: true,
      isRead: true,
      tags: true,
      accountId: true,
    },
  });

  // Push flag changes to the IMAP server (best-effort, non-blocking)
  if (body.isStarred !== undefined || body.isRead !== undefined) {
    // Fire-and-forget: don't await so the response isn't delayed by IMAP latency
    syncMessageFlags(updated.accountId, updated.folder, updated.uid, {
      ...(body.isRead !== undefined ? { isRead: body.isRead } : {}),
      ...(body.isStarred !== undefined ? { isStarred: body.isStarred } : {}),
    }).catch(() => {
      // Already logged inside syncMessageFlags
    });
  }

  return NextResponse.json({
    message: {
      id: updated.id,
      isStarred: updated.isStarred,
      isRead: updated.isRead,
      tags: updated.tags,
    },
  });
}
