import { describe, expect, it } from "vitest";

import { serializeCalendarAccount } from "@/lib/calendar/account-summary";

const row = {
  id: "acct-1",
  name: "Work",
  accountType: "caldav",
  serverUrl: "https://dav.example.com",
  username: "sam",
  authMethod: "basic",
  enabled: true,
  lastSyncedAt: new Date("2026-03-01T10:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  calendars: [
    {
      id: "cal-1",
      remoteId: null,
      name: "Team",
      color: "#3b82f6",
      enabled: false,
      lastSyncedAt: null,
      _count: { events: 12 },
    },
  ],
};

describe("serializeCalendarAccount", () => {
  it("writes dates as ISO strings and flattens the event count", () => {
    expect(serializeCalendarAccount(row)).toEqual({
      id: "acct-1",
      name: "Work",
      accountType: "caldav",
      serverUrl: "https://dav.example.com",
      username: "sam",
      enabled: true,
      lastSyncedAt: "2026-03-01T10:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      calendars: [
        {
          id: "cal-1",
          remoteId: null,
          name: "Team",
          color: "#3b82f6",
          enabled: false,
          lastSyncedAt: null,
          eventCount: 12,
        },
      ],
    });
  });

  it("keeps an unsynced account without calendars", () => {
    const serialized = serializeCalendarAccount({
      ...row,
      lastSyncedAt: null,
      calendars: [],
    });

    expect(serialized.calendars).toEqual([]);
    expect(serialized.lastSyncedAt).toBeNull();
  });
});
