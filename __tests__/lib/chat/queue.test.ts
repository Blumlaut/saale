import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The send queue is the only place a user message can wait without being
 * lost. These tests pin the delivery guarantees: FIFO order, exactly-once
 * claims (concurrent drains), and never deleting a message that was already
 * handed to the agent.
 */

const {
  mockPrisma,
  mockDeleteAllImages,
  mockPublishSessionEvent,
  mockFindFirst,
  mockUpdateMany,
  mockDeleteMany,
} = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockUpdateMany = vi.fn();
  const mockDeleteMany = vi.fn();
  return {
    mockPrisma: {
      chatMessage: {
        findMany: vi.fn(),
        findFirst: mockFindFirst,
        updateMany: mockUpdateMany,
        deleteMany: mockDeleteMany,
        count: vi.fn(),
      },
    },
    mockFindFirst,
    mockUpdateMany,
    mockDeleteMany,
    mockDeleteAllImages: vi.fn().mockResolvedValue(undefined),
    mockPublishSessionEvent: vi.fn().mockResolvedValue(1),
  };
});

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/image-attachment", () => ({ deleteAllImages: mockDeleteAllImages }));
vi.mock("@/lib/pi/session-events", () => ({ publishSessionEvent: mockPublishSessionEvent }));

import {
  claimNextQueuedMessage,
  claimQueuedMessage,
  getQueuedMessage,
  queueMessage,
  removeQueuedMessage,
  restoreQueuedMessage,
  updateQueuedMessageContent,
} from "@/lib/chat/queue";

const SESSION_ID = "session-1";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    sessionId: SESSION_ID,
    role: "user",
    content: "queued text",
    thinking: null,
    toolCalls: null,
    errorMessage: null,
    parentMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    editedAt: null,
    queuedAt: new Date("2026-01-01T00:01:00Z"),
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteAllImages.mockResolvedValue(undefined);
  mockPublishSessionEvent.mockResolvedValue(1);
});

describe("claimNextQueuedMessage", () => {
  it("claims the oldest queued message", async () => {
    const oldest = row({ id: "msg-older", queuedAt: new Date("2026-01-01T00:00:30Z") });
    mockFindFirst.mockResolvedValue(oldest);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const claimed = await claimNextQueuedMessage(SESSION_ID);

    expect(claimed?.id).toBe("msg-older");
    // FIFO: oldest first, and only rows still queued can be claimed.
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: SESSION_ID, queuedAt: { not: null } },
        orderBy: { queuedAt: "asc" },
      }),
    );
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-older", sessionId: SESSION_ID, queuedAt: { not: null } },
      // Delivered: out of the queue, and positioned by the delivery  the
      // turns of the run it waited behind were saved after it was typed.
      data: { queuedAt: null, createdAt: expect.any(Date) },
    });
  });

  it("returns null when the queue is empty", async () => {
    mockFindFirst.mockResolvedValue(null);

    expect(await claimNextQueuedMessage(SESSION_ID)).toBeNull();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("moves to the next message when another drain wins the claim", async () => {
    mockFindFirst
      .mockResolvedValueOnce(row({ id: "msg-1" }))
      .mockResolvedValueOnce(row({ id: "msg-2" }));
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const claimed = await claimNextQueuedMessage(SESSION_ID);

    expect(claimed?.id).toBe("msg-2");
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("gives up (without claiming anything) when every attempt loses the race", async () => {
    mockFindFirst.mockResolvedValue(row({ id: "msg-1" }));
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await claimNextQueuedMessage(SESSION_ID)).toBeNull();
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("contention"));
  });
});

describe("restoreQueuedMessage", () => {
  it("puts a claimed message back at its original queue position", async () => {
    const queuedAt = new Date("2026-01-01T00:01:00Z");
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await restoreQueuedMessage(SESSION_ID, "msg-1", queuedAt);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: null },
      data: { queuedAt },
    });
  });

  it("logs when the message can no longer be requeued", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await restoreQueuedMessage(SESSION_ID, "msg-gone", new Date());

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("msg-gone"));
  });
});

describe("queueMessage", () => {
  it("sends a message that lost its run back to the queue", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    expect(await queueMessage(SESSION_ID, "msg-1")).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: null },
      data: { queuedAt: expect.any(Date) },
    });
  });

  it("leaves a message that is already queued alone", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    expect(await queueMessage(SESSION_ID, "msg-1")).toBe(false);
  });
});

describe("claimQueuedMessage", () => {
  it("reports whether the specific message was still queued", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await claimQueuedMessage(SESSION_ID, "msg-1")).toBe(true);
    expect(await claimQueuedMessage(SESSION_ID, "msg-1")).toBe(false);
  });

  it("stamps the delivery as the message's conversation position", async () => {
    // The queue-time createdAt is when the user typed the message  before the
    // reply it waited behind was saved. Delivery is what puts it in the
    // conversation, so the delivery time has to win.
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();

    await claimQueuedMessage(SESSION_ID, "msg-1");

    const { data } = mockUpdateMany.mock.calls[0]![0] as {
      data: { queuedAt: null; createdAt: Date };
    };
    expect(data.queuedAt).toBeNull();
    expect(data.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("leaves a message somebody else already delivered untouched", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    expect(await claimQueuedMessage(SESSION_ID, "msg-1")).toBe(false);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: { not: null } },
      data: { queuedAt: null, createdAt: expect.any(Date) },
    });
  });
});

describe("updateQueuedMessageContent", () => {
  it("rewrites the text of a queued message and returns it", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindFirst.mockResolvedValue(row({ content: "edited" }));

    const updated = await updateQueuedMessageContent(SESSION_ID, "msg-1", "edited");

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: { not: null } },
      data: { content: "edited", editedAt: expect.any(Date) },
    });
    expect(updated?.content).toBe("edited");
  });

  it("returns null when the message was already delivered", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    expect(await updateQueuedMessageContent(SESSION_ID, "msg-1", "edited")).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe("removeQueuedMessage", () => {
  it("deletes the row and its files", async () => {
    mockFindFirst.mockResolvedValue(
      row({
        attachments: [{ storagePath: "images/a.png" }, { storagePath: "files/b.pdf" }],
      }),
    );
    mockDeleteMany.mockResolvedValue({ count: 1 });

    expect(await removeQueuedMessage("user-1", SESSION_ID, "msg-1")).toBe(true);
    expect(mockDeleteAllImages).toHaveBeenCalledWith("user-1", ["images/a.png", "files/b.pdf"]);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: { not: null } },
    });
  });

  it("refuses to touch a message that is no longer queued", async () => {
    mockFindFirst.mockResolvedValue(null);

    expect(await removeQueuedMessage("user-1", SESSION_ID, "msg-delivered")).toBe(false);
    expect(mockDeleteAllImages).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("still deletes the row when file cleanup fails", async () => {
    mockFindFirst.mockResolvedValue(row({ attachments: [{ storagePath: "images/a.png" }] }));
    mockDeleteAllImages.mockRejectedValue(new Error("disk gone"));
    mockDeleteMany.mockResolvedValue({ count: 1 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await removeQueuedMessage("user-1", SESSION_ID, "msg-1")).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("msg-1"), expect.any(Error));
  });
});

describe("getQueuedMessage", () => {
  it("only matches rows that are still queued", async () => {
    mockFindFirst.mockResolvedValue(null);

    expect(await getQueuedMessage(SESSION_ID, "msg-1")).toBeNull();
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: "msg-1", sessionId: SESSION_ID, queuedAt: { not: null } },
      include: { attachments: true },
    });
  });
});
