import { syncEmailAccount } from "@/lib/email/sync";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";

export const metadata = {
  type: "email_sync",
  label: "Email Sync",
  description: "Sync emails from connected IMAP accounts",
  icon: "RefreshCw",
  defaultCron: "*/30 * * * *",
  usesAi: false,
} as const;

export const fields = [
  {
    key: "accountId",
    label: "Account",
    description: "Leave empty to sync all enabled accounts",
    type: "select" as const,
    default: "",
    options: [] as Array<{ value: string; label: string }>,
  },
];

export async function handler(params: { config: Record<string, unknown>; userId: string }) {
  const { config, userId } = params;
  const accountIds = await resolveUserEmailAccountIds(
    userId,
    config.accountId as string | undefined,
  );

  if (config.accountId) {
    // resolveUserEmailAccountIds has validated the account belongs to this
    // user and is enabled. sync the resolved id, never the raw config value.
    const targetId = accountIds[0];
    if (!targetId) {
      throw new Error(`Email account ${config.accountId} not found or disabled`);
    }
    const result = await syncEmailAccount(targetId);
    return JSON.stringify(result);
  }

  const results = await Promise.all(accountIds.map((id) => syncEmailAccount(id)));
  return JSON.stringify({
    accounts: results.length,
    results,
  });
}
