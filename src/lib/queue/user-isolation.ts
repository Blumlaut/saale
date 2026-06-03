import { prisma } from "@/lib/db";

interface AccountModel {
  findMany(args: {
    where: { userId: string; enabled: boolean };
    select: { id: true };
  }): Promise<Array<{ id: string }>>;
}

/**
 * Resolve this user's enabled account IDs for a given model (user isolation).
 * Optionally validates that a specific accountId belongs to the user.
 */
async function resolveUserAccountIds(
  model: AccountModel,
  userId: string,
  accountId?: string,
): Promise<string[]> {
  const accounts = await model.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });
  const ids = accounts.map((a: { id: string }) => a.id);

  if (accountId && !ids.includes(accountId)) {
    throw new Error(`Account ${accountId} not found`);
  }

  return ids;
}

/**
 * Resolve this user's enabled email account IDs (user isolation).
 */
export async function resolveUserEmailAccountIds(
  userId: string,
  accountId?: string,
): Promise<string[]> {
  return resolveUserAccountIds(prisma.emailAccount, userId, accountId);
}

/**
 * Resolve this user's enabled calendar account IDs (user isolation).
 */
export async function resolveUserCalendarAccountIds(
  userId: string,
  accountId?: string,
): Promise<string[]> {
  return resolveUserAccountIds(prisma.calendarAccount, userId, accountId);
}
