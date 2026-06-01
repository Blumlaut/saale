import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/email/messages/:messageId — Get a single email message (with body)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { messageId } = await params;

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: session.user.id },
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
      bodyHtml: message.bodyHtml,
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
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { messageId } = await params;

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: session.user.id },
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
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
      isStarred: true,
      isRead: true,
      tags: true,
    },
  });

  return NextResponse.json({
    message: {
      id: updated.id,
      isStarred: updated.isStarred,
      isRead: updated.isRead,
      tags: updated.tags,
    },
  });
}
