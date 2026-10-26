import { describe, expect, it } from "vitest";

import { getCronLabel } from "@/lib/jobs/cron-label";

describe("getCronLabel", () => {
  it("names the schedules the app offers", () => {
    expect(getCronLabel("*/10 * * * *")).toBe("Every 10 minutes");
    expect(getCronLabel("0 9 * * 1")).toBe("Monday at 9am");
  });

  it("shows an expression it has no words for as written", () => {
    expect(getCronLabel("15 4 * * 2")).toBe("15 4 * * 2");
  });
});
