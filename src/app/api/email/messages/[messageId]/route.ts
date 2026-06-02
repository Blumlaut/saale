import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
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
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { messageId } = await params;

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: authResult.user.id },
    },
    select: {
      id: true,
      uid: true,
      fromName: true,
      fromEmail: true,
      to: true,
      subject: true,
      date: true,
      bodyPreview: true,
      bodyHtml: true,
      bodyText: true,
      isRead: true,
      isStarred: true,
      folder: true,
      tags: true,
      accountId: true,
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
 * PATCH /api/email/messages/:messageId — Update message fields (star, read, tags)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { messageId } = await params;

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: authResult.user.id },
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
