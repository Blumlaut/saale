import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAccountOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteMailboxRefreshJob, setMailboxRefreshJobEnabled } from "@/lib/email/auto-sync";
import { encrypt } from "@/lib/crypto";

const portSchema = z.number().int().min(1).max(65535);

const updateAccountSchema = z
  .object({
    email: z.string().trim().email().max(254).optional(),
    imapHost: z.string().trim().min(1).max(253).optional(),
    imapPort: portSchema.optional(),
    imapSecure: z.boolean().optional(),
    smtpHost: z.string().trim().min(1).max(253).optional(),
    smtpPort: portSchema.optional(),
    smtpSecure: z.boolean().optional(),
    enabled: z.boolean().optional(),
    password: z.string().min(1).max(512).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

/**
 * PATCH /api/email/accounts/:accountId. Update an email account
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  const parsed = updateAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((e) => e.message).join(", ") },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const updateData: Record<string, unknown> = { ...body };
  if (body.password) {
    delete updateData.password;
    updateData.encryptedPassword = encrypt(body.password);
  }

  let updated;
  try {
    updated = await prisma.emailAccount.update({
      where: { id: accountId },
      data: updateData,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "An account with that email already exists" },
        {
          status: 409,
        },
      );
    }
    throw err;
  }

  // Keep the mailbox refresh job in step with the account's enabled state
  if (body.enabled !== undefined) {
    await setMailboxRefreshJobEnabled(authResult.account.userId, accountId, updated.enabled);
  }

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
 * DELETE /api/email/accounts/:accountId. Delete an email account
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  await deleteMailboxRefreshJob(authResult.account.userId, accountId);

  await prisma.emailAccount.delete({
    where: { id: accountId },
  });

  return NextResponse.json({ ok: true });
}
