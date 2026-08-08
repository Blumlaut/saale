import { NextResponse } from "next/server";
import { requireSession, sanitizeError } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

type AccountSyncResult =
  | {
      accountId: string;
      synced: true;
      newMessages: number;
      updatedMessages: number;
      errors: string[];
    }
  | { accountId: string; synced: false; error: string };

/**
 * POST /api/email/sync — Sync all enabled email accounts for the current user.
 * Fans out to syncEmailAccount for every enabled account owned by the user.
 * Returns 200 with per-account results if at least one account synced,
 * 500 with the aggregated error if every account failed.
 */
export async function POST() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const accounts = await prisma.emailAccount.findMany({
    where: { userId: authResult.user.id, enabled: true },
    select: { id: true },
  });

  const results: AccountSyncResult[] = await Promise.all(
    accounts.map(async ({ id }) => {
      try {
        const result = await syncEmailAccount(id);
        return {
          accountId: id,
          synced: true,
          newMessages: result.newMessages,
          updatedMessages: result.updatedMessages,
          errors: result.errors,
        };
      } catch (err) {
        console.error(`Failed to sync email account ${id}:`, err);
        return { accountId: id, synced: false, error: sanitizeError(err) };
      }
    }),
  );

  const failed = results.filter((r) => !r.synced);
  if (accounts.length > 0 && failed.length === accounts.length) {
    return NextResponse.json(
      {
        synced: false,
        error: failed.map((f) => f.error).join("; "),
        results,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ synced: true, results });
}
