import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isCategoryEnabled,
  normalizeNotificationPreferences,
  readNotificationPreferences,
} from "@/lib/notifications/preferences";

describe("notification preferences", () => {
  it("defaults every category on, so a new subscription reaches the user", () => {
    expect(Object.values(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual([true, true, true, true]);
    expect(readNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("reads a stored switch, and keeps the other categories at their default", () => {
    expect(readNotificationPreferences({ email: false })).toEqual({
      chatDone: true,
      coderDone: true,
      calendar: true,
      email: false,
    });
  });

  it("keeps a stored column sparse by dropping entries equal to the default", () => {
    expect(normalizeNotificationPreferences({ chatDone: true, email: false })).toEqual({
      email: false,
    });
    expect(normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual({});
  });

  it("ignores unknown categories and non-boolean values", () => {
    expect(normalizeNotificationPreferences({ sound: true, email: "no", calendar: false })).toEqual(
      {
        calendar: false,
      },
    );
    expect(readNotificationPreferences(["chatDone"])).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("answers per category for the notify path", () => {
    expect(isCategoryEnabled({ coderDone: false }, "coderDone")).toBe(false);
    expect(isCategoryEnabled({ coderDone: false }, "chatDone")).toBe(true);
  });
});
