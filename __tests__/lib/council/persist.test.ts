import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    council: { findFirst: vi.fn(), updateMany: vi.fn() },
    councilMessage: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    councilRun: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    councilMemberTurn: { create: vi.fn(), update: vi.fn() },
    user: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/db";
import {
  beginRun,
  failStaleRuns,
  finishRun,
  loadCouncil,
  loadOwnerName,
  postRoomMessage,
  readRoomMessages,
  readRoomWindow,
} from "@/lib/council/persist";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadCouncil", () => {
  it("scopes the lookup to the user, so a guessed id is not enough", async () => {
    db.council.findFirst.mockResolvedValue(null);
    expect(await loadCouncil("council-1", "user-1")).toBeNull();
    expect(db.council.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "council-1", userId: "user-1" } }),
    );
  });

  it("returns the council with its members in creation order", async () => {
    db.council.findFirst.mockResolvedValue({
      id: "council-1",
      userId: "user-1",
      name: "Launch review",
      brief: "Decide.",
      orchestration: "parallel",
      stopVoteThreshold: "majority",
      toolConfig: { web: true },
      maxDurationSeconds: null,
      maxTokens: null,
      maxCostUsd: null,
      sandboxKey: "abcd1234",
      sandboxReady: false,
      status: "idle",
      members: [
        {
          id: "m1",
          name: "acorn",
          enabled: true,
          instructions: null,
          modelProvider: "anthropic",
          modelName: "claude-x",
          thinkingLevel: "default",
          toolConfig: null,
        },
      ],
    });

    const loaded = await loadCouncil("council-1", "user-1");
    expect(loaded!.council.name).toBe("Launch review");
    expect(loaded!.council.toolConfig).toEqual({ web: true });
    expect(loaded!.members).toHaveLength(1);
    expect(db.council.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: { members: { orderBy: { createdAt: "asc" } } } }),
    );
  });
});

describe("loadOwnerName", () => {
  it("prefers the display name and falls back to the username", async () => {
    db.user.findFirst.mockResolvedValue({ name: "  Ada  ", username: "ada" });
    expect(await loadOwnerName("user-1")).toBe("Ada");

    db.user.findFirst.mockResolvedValue({ name: null, username: "ada" });
    expect(await loadOwnerName("user-1")).toBe("ada");

    db.user.findFirst.mockResolvedValue(null);
    expect(await loadOwnerName("user-1")).toBe("the owner");
  });
});

describe("postRoomMessage", () => {
  it("allocates the sequence atomically and stores the message with it", async () => {
    db.$queryRaw.mockResolvedValue([{ nextSeq: 7 }]);
    db.councilMessage.create.mockImplementation(async ({ data }: any) => ({
      ...data,
      id: "msg-1",
      createdAt: new Date(),
    }));

    const message = await postRoomMessage({
      councilId: "council-1",
      userId: "user-1",
      runId: "run-1",
      authorKind: "member",
      memberId: "m1",
      authorName: "acorn",
      content: "hello @blade",
      mentions: ["blade"],
    });

    expect(message).toMatchObject({ seq: 7, authorName: "acorn", addressedNames: ["blade"] });
    expect(db.councilMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seq: 7, userId: "user-1" }) }),
    );
  });

  it("fails rather than writing a message with no sequence when the council is not the user's", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(
      postRoomMessage({
        councilId: "council-1",
        userId: "user-2",
        runId: null,
        authorKind: "user",
        authorName: "Ada",
        content: "hello",
        mentions: [],
      }),
    ).rejects.toThrow(/not found for user/);
    expect(db.councilMessage.create).not.toHaveBeenCalled();
  });
});

describe("readRoomWindow", () => {
  it("keeps the newest messages and reports how many older ones were skipped", async () => {
    const rows = [5, 6, 7].map((seq) => ({
      seq,
      memberId: null,
      authorName: "acorn",
      authorKind: "member",
      content: `m${seq}`,
      mentions: [],
    }));
    // Newest first, as the query asks for them.
    db.councilMessage.findMany.mockResolvedValue([...rows].reverse());
    db.councilMessage.count.mockResolvedValue(9);

    const window = await readRoomWindow({
      councilId: "council-1",
      userId: "user-1",
      afterSeq: 0,
      limit: 3,
    });

    expect(window.messages.map((m) => m.seq)).toEqual([5, 6, 7]);
    expect(window.skippedBefore).toBe(6);
  });
});

describe("readRoomMessages", () => {
  const row = (seq: number) => ({
    seq,
    memberId: null,
    authorName: "acorn",
    authorKind: "member",
    content: `m${seq}`,
    mentions: [],
  });

  it("reads backward by default: the newest messages, oldest first", async () => {
    db.councilMessage.findMany.mockResolvedValue([row(9), row(8), row(7)]);
    const messages = await readRoomMessages({ councilId: "council-1", userId: "user-1", limit: 3 });
    expect(messages.map((m) => m.seq)).toEqual([7, 8, 9]);
    expect(db.councilMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { seq: "desc" } }),
    );
  });

  it("reads forward when asked, which is what council_read means", async () => {
    db.councilMessage.findMany.mockResolvedValue([row(4), row(5)]);
    const messages = await readRoomMessages({
      councilId: "council-1",
      userId: "user-1",
      afterSeq: 3,
      limit: 2,
      order: "oldest",
    });
    expect(messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(db.councilMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { seq: "asc" },
        where: expect.objectContaining({ seq: { gt: 3 } }),
      }),
    );
  });

  it("filters by member without losing the user scope", async () => {
    db.councilMessage.findMany.mockResolvedValue([]);
    await readRoomMessages({
      councilId: "council-1",
      userId: "user-1",
      limit: 10,
      memberId: "m1",
    });
    expect(db.councilMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          councilId: "council-1",
          userId: "user-1",
          memberId: "m1",
        }),
      }),
    );
  });
});

describe("beginRun", () => {
  it("takes the run slot only if the council is not already running", async () => {
    db.council.updateMany.mockResolvedValue({ count: 0 });
    const started = await beginRun({
      councilId: "council-1",
      userId: "user-1",
      budget: { maxDurationSeconds: 60, maxTokens: 100, maxCostUsd: 1 },
      triggerMessageId: null,
    });

    expect(started).toBeNull();
    expect(db.councilRun.create).not.toHaveBeenCalled();
    expect(db.council.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "council-1", userId: "user-1", status: { not: "running" } },
      }),
    );
  });

  it("creates the run with the budget it will be held to", async () => {
    db.council.updateMany.mockResolvedValue({ count: 1 });
    db.councilRun.create.mockResolvedValue({ id: "run-1" });

    const started = await beginRun({
      councilId: "council-1",
      userId: "user-1",
      budget: { maxDurationSeconds: 60, maxTokens: 100, maxCostUsd: 1 },
      triggerMessageId: "msg-9",
    });

    expect(started).toEqual({ runId: "run-1" });
    expect(db.councilRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          councilId: "council-1",
          userId: "user-1",
          status: "running",
          maxDurationSeconds: 60,
          maxTokens: 100,
          maxCostUsd: 1,
          triggerMessageId: "msg-9",
        }),
      }),
    );
  });
});

describe("finishRun", () => {
  it("leaves a waiting run open, so the room is not shown as finished", async () => {
    await finishRun("run-1", { status: "waiting", stopReason: "user-question" });
    expect(db.councilRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: null }) }),
    );
  });

  it("records the reason and the error for a failure", async () => {
    await finishRun("run-1", { status: "failed", stopReason: "error", error: "boom" });
    const data = db.councilRun.update.mock.calls[0][0].data;
    expect(data.stopReason).toBe("error");
    expect(data.error).toBe("boom");
    expect(data.completedAt).toBeInstanceOf(Date);
  });
});

describe("failStaleRuns", () => {
  it("fails a run whose heartbeat stopped, and releases its council", async () => {
    db.councilRun.findMany.mockResolvedValue([
      { id: "run-1", councilId: "council-1", userId: "user-1" },
    ]);
    db.councilRun.updateMany.mockResolvedValue({ count: 1 });
    db.council.updateMany.mockResolvedValue({ count: 1 });

    const failed = await failStaleRuns(90_000);

    expect(failed).toBe(1);
    expect(db.councilRun.updateMany).toHaveBeenCalledTimes(1);
    expect(db.councilRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "running",
          id: { in: ["run-1"] },
        }),
        data: expect.objectContaining({ status: "failed", stopReason: "timeout" }),
      }),
    );
    expect(db.council.updateMany).toHaveBeenCalledWith({
      where: { id: "council-1", userId: "user-1" },
      data: { status: "idle" },
    });
  });

  it("releases a council with several stale runs only once", async () => {
    db.councilRun.findMany.mockResolvedValue([
      { id: "run-1", councilId: "council-1", userId: "user-1" },
      { id: "run-2", councilId: "council-1", userId: "user-1" },
    ]);
    db.councilRun.updateMany.mockResolvedValue({ count: 2 });
    db.council.updateMany.mockResolvedValue({ count: 1 });

    expect(await failStaleRuns(90_000)).toBe(2);
    expect(db.councilRun.updateMany).toHaveBeenCalledTimes(1);
    expect(db.council.updateMany).toHaveBeenCalledTimes(1);
  });

  it("leaves a fresh run alone", async () => {
    db.councilRun.findMany.mockResolvedValue([]);
    expect(await failStaleRuns(90_000)).toBe(0);
    expect(db.councilRun.updateMany).not.toHaveBeenCalled();
  });

  it("only considers runs that claim to be running", async () => {
    db.councilRun.findMany.mockResolvedValue([]);
    await failStaleRuns(1000);
    expect(db.councilRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running" }),
      }),
    );
  });
});
