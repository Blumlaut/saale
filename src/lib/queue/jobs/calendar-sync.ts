import { syncCalendarAccount } from "@/lib/calendar/sync";
import { resolveUserCalendarAccountIds } from "@/lib/queue/user-isolation";

export const metadata = {
  type: "calendar_sync",
  label: "Calendar Sync",
  description: "Sync events from connected CalDAV accounts",
  icon: "Calendar",
  defaultCron: "*/15 * * * *",
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
  const accountIds = await resolveUserCalendarAccountIds(
    userId,
    config.accountId as string | undefined,
  );

  if (config.accountId) {
    const result = await syncCalendarAccount(config.accountId as string);
    return JSON.stringify(result);
  }

  const results = await Promise.all(accountIds.map((id) => syncCalendarAccount(id)));
  return JSON.stringify({
    accounts: results.length,
    results,
  });
}
