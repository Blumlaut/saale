import { NextRequest, NextResponse } from "next/server";
import { requireAccountOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

/**
 * PATCH /api/email/accounts/:accountId — Update an email account
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.email !== undefined) updateData.email = body.email;
  if (body.imapHost !== undefined) updateData.imapHost = body.imapHost;
  if (body.imapPort !== undefined) updateData.imapPort = body.imapPort;
  if (body.imapSecure !== undefined) updateData.imapSecure = body.imapSecure;
  if (body.smtpHost !== undefined) updateData.smtpHost = body.smtpHost;
  if (body.smtpPort !== undefined) updateData.smtpPort = body.smtpPort;
  if (body.smtpSecure !== undefined) updateData.smtpSecure = body.smtpSecure;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.password) {
    updateData.encryptedPassword = encrypt(body.password);
  }

  const updated = await prisma.emailAccount.update({
    where: { id: accountId },
    data: updateData,
  });

  return NextResponse.json({
    account: {
      id: updated.id,
      email: updated.email,
      enabled: updated.enabled,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/email/accounts/:accountId — Delete an email account
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  await prisma.emailAccount.delete({
    where: { id: accountId },
  });

  return NextResponse.json({ ok: true });
}
