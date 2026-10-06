import { describe, it, expect } from "vitest";
import {
  assertValidTimeZone,
  formatLocalWallClock,
  formatWallClock,
  hasExplicitOffset,
  isValidTimeZone,
  moveToTimeZone,
  resolveEventDateTime,
  toZonedDate,
} from "@/lib/calendar/timezone";

describe("resolveEventDateTime", () => {
  it("keeps an absolute value as the instant it denotes", () => {
    expect(resolveEventDateTime("2026-01-15T09:00:00Z").toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(resolveEventDateTime("2026-01-15T09:00:00+02:00").toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
    expect(resolveEventDateTime("2026-01-15T09:00:00-0500").toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("anchors a wall clock in the given timezone", () => {
    expect(
      resolveEventDateTime("2026-01-15T09:00:00", { timeZone: "Europe/Athens" }).toISOString(),
    ).toBe("2026-01-15T07:00:00.000Z");
  });

  it("uses the timezone offset in force on that date, not a fixed one", () => {
    // Athens is UTC+2 in winter and UTC+3 in summer.
    expect(
      resolveEventDateTime("2026-07-15T09:00:00", { timeZone: "Europe/Athens" }).toISOString(),
    ).toBe("2026-07-15T06:00:00.000Z");
    expect(
      resolveEventDateTime("2026-01-15T09:00:00", { timeZone: "America/New_York" }).toISOString(),
    ).toBe("2026-01-15T14:00:00.000Z");
    expect(
      resolveEventDateTime("2026-07-15T09:00:00", { timeZone: "America/New_York" }).toISOString(),
    ).toBe("2026-07-15T13:00:00.000Z");
  });

  it("treats a wall clock without a timezone as UTC", () => {
    expect(resolveEventDateTime("2026-01-15T09:00:00").toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    expect(resolveEventDateTime("2026-01-15T09:00:00", { timeZone: null }).toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
  });

  it("accepts a space separator, missing seconds and sub-second precision", () => {
    expect(resolveEventDateTime("2026-01-15 09:30", { timeZone: "UTC" }).toISOString()).toBe(
      "2026-01-15T09:30:00.000Z",
    );
    expect(resolveEventDateTime("2026-01-15T09:30:15.250Z").toISOString()).toBe(
      "2026-01-15T09:30:15.250Z",
    );
    expect(resolveEventDateTime("2026-01-15", { timeZone: "Europe/Athens" }).toISOString()).toBe(
      "2026-01-14T22:00:00.000Z",
    );
  });

  it("shifts a wall clock that does not exist into the DST gap", () => {
    // 03:30 on 2026-03-29 never happens in Athens (clocks jump 03:00 → 04:00).
    expect(
      resolveEventDateTime("2026-03-29T03:30:00", { timeZone: "Europe/Athens" }).toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("resolves an ambiguous wall clock to the offset in force after the transition", () => {
    // 03:30 on 2026-10-25 happens twice in Athens (UTC+3 then UTC+2).
    expect(
      resolveEventDateTime("2026-10-25T03:30:00", { timeZone: "Europe/Athens" }).toISOString(),
    ).toBe("2026-10-25T01:30:00.000Z");
  });

  it("stores all-day dates as UTC midnight and ignores the clock", () => {
    expect(
      resolveEventDateTime("2026-01-15", { timeZone: "Europe/Athens", allDay: true }).toISOString(),
    ).toBe("2026-01-15T00:00:00.000Z");
    expect(
      resolveEventDateTime("2026-01-15T00:00:00+02:00", {
        timeZone: "America/New_York",
        allDay: true,
      }).toISOString(),
    ).toBe("2026-01-15T00:00:00.000Z");
  });

  it("rejects an unknown timezone instead of falling back to UTC", () => {
    expect(() =>
      resolveEventDateTime("2026-01-15T09:00:00", { timeZone: "Europe/Athenz" }),
    ).toThrow(/Unknown timezone "Europe\/Athenz"/);
    expect(() => resolveEventDateTime("2026-01-15T09:00:00", { timeZone: "CEST" })).toThrow(
      /Unknown timezone/,
    );
    expect(() => resolveEventDateTime("2026-01-15T09:00:00", { timeZone: "+02:00" })).toThrow(
      /Unknown timezone/,
    );
  });

  it("rejects values it cannot interpret", () => {
    expect(() => resolveEventDateTime("")).toThrow(/Missing datetime/);
    expect(() => resolveEventDateTime("tomorrow at 9")).toThrow(/Invalid datetime/);
    expect(() => resolveEventDateTime("2026-01-15T09:00:00+02:00:00")).toThrow(/Invalid datetime/);
    expect(() => resolveEventDateTime("2026-02-30T09:00:00")).toThrow(/does not exist/);
    expect(() => resolveEventDateTime("2026-13-01T09:00:00")).toThrow(/Invalid date/);
    expect(() => resolveEventDateTime("2026-01-15T25:00:00")).toThrow(/Invalid time/);
  });
});

describe("isValidTimeZone / assertValidTimeZone", () => {
  it("accepts IANA zones and UTC, and rejects labels that are not zones", () => {
    for (const zone of ["UTC", "Europe/Athens", "America/New_York", "Etc/GMT+2"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
    for (const zone of ["Europe/Athenz", "CEST", "", "UTC+2", "Mars/Olympus", "+02:00"]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });

  it("returns the zone when valid and throws with guidance when not", () => {
    expect(assertValidTimeZone("Europe/Athens")).toBe("Europe/Athens");
    expect(() => assertValidTimeZone("nope")).toThrow(/IANA identifier such as "Europe\/Athens"/);
  });
});

describe("formatWallClock", () => {
  it("reads a UTC instant on the given zone's clock", () => {
    const instant = new Date("2026-01-15T07:00:00.000Z");
    expect(formatWallClock(instant, "Europe/Athens")).toBe("2026-01-15T09:00:00");
    expect(formatWallClock(instant, "UTC")).toBe("2026-01-15T07:00:00");
    expect(formatWallClock(instant, "America/New_York")).toBe("2026-01-15T02:00:00");
  });

  it("round-trips through resolveEventDateTime", () => {
    const instant = new Date("2026-07-01T22:45:30.000Z");
    const wallClock = formatWallClock(instant, "Europe/Athens");
    expect(wallClock).toBe("2026-07-02T01:45:30");
    expect(resolveEventDateTime(wallClock, { timeZone: "Europe/Athens" }).toISOString()).toBe(
      "2026-07-01T22:45:30.000Z",
    );
  });

  it("refuses an unknown zone", () => {
    expect(() => formatWallClock(new Date(), "Nope/Nope")).toThrow(/Unknown timezone/);
  });
});

describe("formatLocalWallClock", () => {
  it("reads the machine's own clock and inverts back to the same instant", () => {
    const date = new Date("2026-01-15T07:00:00.000Z");
    const wallClock = formatLocalWallClock(date);
    expect(resolveEventDateTime(wallClock, { timeZone: "UTC" }).toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
  });
});

describe("moveToTimeZone", () => {
  it("keeps the local time and moves the instant", () => {
    const athensMorning = new Date("2026-01-15T07:00:00.000Z"); // 09:00 in Athens
    const moved = moveToTimeZone(athensMorning, "Europe/Athens", "Asia/Tokyo");
    expect(moved.toISOString()).toBe("2026-01-15T00:00:00.000Z"); // 09:00 in Tokyo
    expect(formatWallClock(moved, "Asia/Tokyo")).toBe("2026-01-15T09:00:00");
  });

  it("re-reads the wall clock after a DST change on the way", () => {
    const winter = new Date("2026-01-15T07:00:00.000Z"); // 09:00 Athens (UTC+2)
    const moved = moveToTimeZone(winter, "Europe/Athens", "America/New_York");
    expect(formatWallClock(moved, "America/New_York")).toBe("2026-01-15T09:00:00");
  });
});

describe("toZonedDate", () => {
  it("exposes the zone's wall clock while keeping the instant", () => {
    const instant = new Date("2026-01-15T07:00:00.000Z");
    const zoned = toZonedDate(instant, "Europe/Athens");
    expect(zoned.getTime()).toBe(instant.getTime());
    expect(zoned.getHours()).toBe(9);
    expect(zoned.getDate()).toBe(15);
  });

  it("survives a withTimeZone call by ical-generator (same instant)", () => {
    const zoned = toZonedDate(new Date("2026-01-15T07:00:00.000Z"), "Europe/Athens");
    expect(zoned.withTimeZone("Europe/Athens").getTime()).toBe(zoned.getTime());
    expect(zoned.withTimeZone("Europe/Athens").getHours()).toBe(9);
  });
});

describe("hasExplicitOffset", () => {
  it("detects absolute values only", () => {
    expect(hasExplicitOffset("2026-01-15T09:00:00Z")).toBe(true);
    expect(hasExplicitOffset("2026-01-15T09:00:00z")).toBe(true);
    expect(hasExplicitOffset("2026-01-15T09:00:00+02:00")).toBe(true);
    expect(hasExplicitOffset("2026-01-15T09:00:00-0500")).toBe(true);
    expect(hasExplicitOffset(" 2026-01-15T09:00:00 ")).toBe(false);
    expect(hasExplicitOffset("2026-01-15")).toBe(false);
    expect(hasExplicitOffset("2026-01-15T09:00:00")).toBe(false);
  });
});
