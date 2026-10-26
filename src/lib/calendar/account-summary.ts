/**
 * The calendar account shape both account endpoints return: the account, its
 * calendars, and how many events each calendar holds.
 */

import type { CalendarAccountSummary } from "@/types/shared";

/** The columns every calendar account response carries. */
export const CALENDAR_ACCOUNT_SELECT = {
  id: true,
  name: true,
  accountType: true,
  serverUrl: true,
  username: true,
  authMethod: true,
  enabled: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
  calendars: {
    select: {
      id: true,
      remoteId: true,
      name: true,
      color: true,
      enabled: true,
      lastSyncedAt: true,
      _count: { select: { events: true } },
    },
    orderBy: { name: "asc" },
  },
} as const;

/** A row read through `CALENDAR_ACCOUNT_SELECT`. */
interface CalendarAccountRow {
  id: string;
  name: string;
  accountType: string;
  serverUrl: string | null;
  username: string | null;
  enabled: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  calendars: Array<{
    id: string;
    remoteId: string | null;
    name: string;
    color: string | null;
    enabled: boolean;
    lastSyncedAt: Date | null;
    _count: { events: number };
  }>;
}

/** The account as the UI takes it, with dates as ISO strings. */
export function serializeCalendarAccount(account: CalendarAccountRow): CalendarAccountSummary & {
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: account.id,
    name: account.name,
    accountType: account.accountType,
    serverUrl: account.serverUrl,
    username: account.username,
    enabled: account.enabled,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    calendars: account.calendars.map((calendar) => ({
      id: calendar.id,
      remoteId: calendar.remoteId,
      name: calendar.name,
      color: calendar.color,
      enabled: calendar.enabled,
      lastSyncedAt: calendar.lastSyncedAt?.toISOString() ?? null,
      eventCount: calendar._count.events,
    })),
  };
}
