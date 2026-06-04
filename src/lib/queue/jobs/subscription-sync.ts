export const metadata = {
  type: "subscription_sync",
  label: "ICS Subscription Sync",
  description: "Sync events from remote ICS URL subscriptions into local calendars",
  icon: "Download",
  defaultCron: "*/30 * * * *",
  usesAi: false,
} as const;

export const fields: Array<{
  key: string;
  label: string;
  description?: string;
  type: "text" | "number" | "select" | "boolean" | "model";
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}> = [];

export async function handler(params: { config: Record<string, unknown>; userId: string }) {
  const { syncAllSubscriptions } = await import("@/lib/calendar/subscription-sync");
  const result = await syncAllSubscriptions(params.userId);
  return JSON.stringify(result);
}
