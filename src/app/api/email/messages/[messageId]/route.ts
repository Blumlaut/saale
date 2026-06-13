import { NextRequest, NextResponse } from "next/server";
import { requireEmailMessageOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncMessageFlags, deleteMessage, moveMessage } from "@/lib/email/imap";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";

/**
 * GET /api/email/messages/:messageId — Get a single email message (with body)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  const authResult = await requireEmailMessageOwner(messageId);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({
    message: {
      id: authResult.message.id,
      uid: authResult.message.uid,
      fromName: authResult.message.fromName,
      fromEmail: authResult.message.fromEmail,
      to: authResult.message.to,
      subject: authResult.message.subject,
      date: authResult.message.date.toISOString(),
      bodyPreview: authResult.message.bodyPreview,
      bodyHtml: sanitizeEmailHtml(authResult.message.bodyHtml),
      bodyText: authResult.message.bodyText,
      isRead: authResult.message.isRead,
      isStarred: authResult.message.isStarred,
      folder: authResult.message.folder,
      tags: authResult.message.tags,
      accountId: authResult.message.accountId,
    },
  });
}

/**
 * PATCH /api/email/messages/:messageId — Update message fields (star, read, tags)
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
    // Delete on IMAP server (best-effort, non-blocking)
    deleteMessage(message.accountId, message.folder, message.uid).catch(() => {
      // Already logged inside deleteMessage
    });

    // Remove from local DB
    await prisma.emailMessage.delete({ where: { id: messageId } });
    return NextResponse.json({ trashed: true });
  }

  // ── Archive action ────────────────────────────────────────────
  if (body.action === "archive") {
    // Determine archive folder from the account's cached folders
    const account = await prisma.emailAccount.findUnique({
      where: { id: message.accountId },
      select: { cachedFolders: true },
    });

    // Find the archive folder name
    let archiveFolder = "Archive";
    if (account?.cachedFolders && Array.isArray(account.cachedFolders)) {
      const folders = account.cachedFolders as string[];
      const archiveMatch = folders.find(
        (f) =>
          f.toUpperCase() === "ARCHIVE" ||
          f.toUpperCase() === "ALL MAIL" ||
          f.toLowerCase() === "all mail",
      );
      if (archiveMatch) archiveFolder = archiveMatch;
    }

    // Move on IMAP server (best-effort, non-blocking)
    moveMessage(message.accountId, message.folder, message.uid, archiveFolder).catch(() => {
      // Already logged inside moveMessage
    });

    // Update local DB
    await prisma.emailMessage.update({
      where: { id: messageId },
      data: { folder: archiveFolder },
    });

    return NextResponse.json({ archived: true, folder: archiveFolder });
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
