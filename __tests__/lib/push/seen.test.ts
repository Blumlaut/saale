import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

import { resetMockRedis } from "../../helpers/in-memory-redis";
import { markPushSeen, notificationPath, wasPushSeenSince } from "@/lib/push/seen";

const USER_ID = "user-1";
const CHAT_URL = "/dashboard/chat/chat-1";

describe("notificationPath", () => {
  it("keeps a plain path", () => {
    expect(notificationPath(CHAT_URL)).toBe(CHAT_URL);
  });

  it("drops a query, a fragment and a trailing slash", () => {
    expect(notificationPath("/dashboard/mail/?folder=inbox#top")).toBe("/dashboard/mail");
  });

  it("reads a path out of an absolute URL", () => {
    expect(notificationPath("https://saale.example.com/dashboard/calendar")).toBe(
      "/dashboard/calendar",
    );
  });
});

describe("push seen tracking", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  it("answers nothing seen before any report", async () => {
    await expect(wasPushSeenSince(USER_ID, CHAT_URL, 0)).resolves.toBe(false);
  });

  it("counts a report made after the notification was queued", async () => {
    const queuedAt = Date.now() - 60_000;

    await markPushSeen(USER_ID, CHAT_URL);

    await expect(wasPushSeenSince(USER_ID, CHAT_URL, queuedAt)).resolves.toBe(true);
  });

  it("ignores a report from before the notification existed", async () => {
    await markPushSeen(USER_ID, CHAT_URL);

    await expect(wasPushSeenSince(USER_ID, CHAT_URL, Date.now() + 1_000)).resolves.toBe(false);
  });

  it("keeps one user's reading out of another's", async () => {
    await markPushSeen(USER_ID, CHAT_URL);

    await expect(wasPushSeenSince("user-2", CHAT_URL, 0)).resolves.toBe(false);
  });

  it("matches the same page reported with its origin and query", async () => {
    await markPushSeen(USER_ID, `https://saale.example.com${CHAT_URL}?tab=1`);

    await expect(wasPushSeenSince(USER_ID, `${CHAT_URL}/`, 0)).resolves.toBe(true);
  });
});
