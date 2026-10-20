import { describe, it, expect } from "vitest";
import {
  OLD_CHAT_INACTIVITY_DAYS,
  lastActivityTimestamp,
  splitSessionsByActivity,
} from "@/lib/chat/session-recency";

const NOW = Date.parse("2025-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function session(id: string, daysAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    lastActivityAt: new Date(NOW - daysAgo * DAY).toISOString(),
    updatedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    ...overrides,
  };
}

describe("splitSessionsByActivity", () => {
  it("keeps chats used inside the window recent and folds the rest", () => {
    const sessions = [
      session("today", 0),
      session("two-days", 2),
      session("five-days", OLD_CHAT_INACTIVITY_DAYS),
      session("six-days", 6),
      session("two-weeks", 14),
    ];

    const { recent, older } = splitSessionsByActivity(sessions, NOW);

    // Exactly at the cutoff still counts as recent  only *more* than the
    // window of inactivity folds away.
    expect(recent.map((s) => s.id)).toEqual(["today", "two-days", "five-days"]);
    expect(older.map((s) => s.id)).toEqual(["six-days", "two-weeks"]);
  });

  it("returns an empty older group when every chat is active", () => {
    const { recent, older } = splitSessionsByActivity([session("a", 0.5), session("b", 3)], NOW);

    expect(older).toEqual([]);
    expect(recent).toHaveLength(2);
  });

  it("returns an empty recent group when every chat is stale", () => {
    const { recent, older } = splitSessionsByActivity([session("a", 8), session("b", 30)], NOW);

    expect(recent).toEqual([]);
    expect(older.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("preserves the incoming order of both groups", () => {
    const { recent, older } = splitSessionsByActivity(
      [session("stale-1", 9), session("fresh-1", 1), session("stale-2", 20), session("fresh-2", 4)],
      NOW,
    );

    expect(recent.map((s) => s.id)).toEqual(["fresh-1", "fresh-2"]);
    expect(older.map((s) => s.id)).toEqual(["stale-1", "stale-2"]);
  });

  it("falls back to updatedAt when a session has no lastActivityAt", () => {
    const { recent, older } = splitSessionsByActivity(
      [
        { id: "legacy-fresh", updatedAt: new Date(NOW - 1 * DAY).toISOString() },
        { id: "legacy-stale", updatedAt: new Date(NOW - 10 * DAY).toISOString() },
      ],
      NOW,
    );

    expect(recent.map((s) => s.id)).toEqual(["legacy-fresh"]);
    expect(older.map((s) => s.id)).toEqual(["legacy-stale"]);
  });

  it("keeps chats with unparseable timestamps visible", () => {
    const broken = { id: "broken", lastActivityAt: "not-a-date", updatedAt: "not-a-date" };

    const { recent, older } = splitSessionsByActivity([broken], NOW);

    expect(recent.map((s) => s.id)).toEqual(["broken"]);
    expect(older).toEqual([]);
    expect(lastActivityTimestamp(broken)).toBe(Infinity);
  });
});
