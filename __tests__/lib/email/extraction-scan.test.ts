import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    emailMessage: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/queue/job-handler", () => ({
  dispatchAiJob: vi.fn(),
}));

import * as db from "@/lib/db";
import { askForJson, scanUnreadEmails } from "@/lib/email/extraction-scan";

const prismaMock = vi.mocked(db.prisma, { deep: true });

const email = (id: string) => ({
  id,
  subject: `Subject ${id}`,
  bodyText: "body",
  bodyPreview: null,
  date: new Date("2026-05-01T09:00:00.000Z"),
  accountId: "acc-1",
});

describe("scanUnreadEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.emailMessage.update.mockResolvedValue({} as never);
  });

  it("marks every email before handing it to the extractor and sums what came back", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([email("a"), email("b")] as never);

    const seen: string[] = [];
    const result = await scanUnreadEmails({
      tag: "test",
      scannedFlag: "taskScanned",
      userId: "user-1",
      process: async (scanned) => {
        // The flag is already set when the extractor runs, so a retry is quiet.
        expect(prismaMock.emailMessage.update).toHaveBeenCalledWith({
          where: { id: scanned.id },
          data: { taskScanned: true },
        });
        seen.push(scanned.id);
        return scanned.id === "a" ? { created: 2, skipped: 1 } : { created: 0, skipped: 3 };
      },
    });

    expect(seen).toEqual(["a", "b"]);
    expect(result).toEqual({ emailsScanned: 2, created: 2, skipped: 4, errors: [] });
  });

  it("filters by the extractor's own flag, the account and the age limit", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([] as never);

    await scanUnreadEmails({
      tag: "test",
      scannedFlag: "calendarScanned",
      userId: "user-1",
      accountId: "acc-9",
      maxEmailAge: 48,
      limit: 500,
      process: async () => ({ created: 1 }),
    });

    const query = prismaMock.emailMessage.findMany.mock.calls[0]?.[0];
    expect(query?.where).toMatchObject({ calendarScanned: false, accountId: "acc-9" });
    expect(query?.where?.date).toHaveProperty("gte");
    expect(query?.take).toBe(100);
  });

  it("leaves the age filter off when the limit is zero", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([] as never);

    await scanUnreadEmails({
      tag: "test",
      scannedFlag: "taskScanned",
      userId: "user-1",
      maxEmailAge: 0,
      process: async () => ({ created: 1 }),
    });

    expect(prismaMock.emailMessage.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty("date");
  });

  it("keeps going after one email throws, and files the failure", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([email("a"), email("b")] as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await scanUnreadEmails({
      tag: "test",
      scannedFlag: "taskScanned",
      userId: "user-1",
      process: async (scanned) => {
        if (scanned.id === "a") throw new Error("model offline");
        return { created: 1 };
      },
    });

    expect(result).toMatchObject({ emailsScanned: 2, created: 1 });
    expect(result.errors).toEqual([`Failed to process email "Subject a": model offline`]);
    error.mockRestore();
  });
});

describe("askForJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses an answer wrapped in a markdown fence", async () => {
    vi.mocked((await import("@/lib/queue/job-handler")).dispatchAiJob).mockResolvedValue(
      '```json\n{"title":"Standup"}\n```',
    );

    const parsed = await askForJson<{ title: string }>("user-1", { email: "x" }, { tag: "test" });
    expect(parsed).toEqual({ title: "Standup" });
  });

  it("gives back null for an empty answer or one that is not JSON", async () => {
    const dispatch = vi.mocked((await import("@/lib/queue/job-handler")).dispatchAiJob);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    dispatch.mockResolvedValue("NULL");
    await expect(askForJson("user-1", {}, { tag: "test" })).resolves.toBeNull();

    dispatch.mockResolvedValue("not json at all");
    await expect(askForJson("user-1", {}, { tag: "test" })).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
