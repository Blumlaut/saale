import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLrange, mockExec, mockDel, mockRpush, mockLtrim } = vi.hoisted(() => ({
  mockLrange: vi.fn(),
  mockExec: vi.fn(),
  mockDel: vi.fn(),
  mockRpush: vi.fn(),
  mockLtrim: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    lrange: mockLrange,
    multi: () => {
      const pipeline = {
        del: mockDel,
        rpush: mockRpush,
        ltrim: mockLtrim,
        exec: mockExec,
      };
      mockDel.mockReturnValue(pipeline);
      mockRpush.mockReturnValue(pipeline);
      mockLtrim.mockReturnValue(pipeline);
      return pipeline;
    },
  }),
}));

import { listInboxNotifications, markInboxNotifications } from "@/lib/notifications/inbox";

function stored(id: string, read: boolean): string {
  return JSON.stringify({
    id,
    type: "email",
    title: `notice ${id}`,
    message: "body",
    data: {},
    read,
    createdAt: new Date().toISOString(),
  });
}

/** What the write-back pushed, parsed. */
function written(): Array<{ id: string; read: boolean }> {
  const args = (mockRpush.mock.calls[0] ?? []) as string[];
  return args.slice(1).map((entry) => JSON.parse(entry));
}

describe("markInboxNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue([]);
    mockLrange.mockResolvedValue([stored("a", false), stored("b", true), stored("c", false)]);
  });

  it("marks every unread entry when asked for all of them", async () => {
    await markInboxNotifications("user-1", { all: true });

    expect(written()).toEqual([
      expect.objectContaining({ id: "a", read: true }),
      expect.objectContaining({ id: "b", read: true }),
      expect.objectContaining({ id: "c", read: true }),
    ]);
  });

  it("marks only the entries it was given", async () => {
    await markInboxNotifications("user-1", { ids: ["c"] });

    expect(written()).toEqual([
      expect.objectContaining({ id: "a", read: false }),
      expect.objectContaining({ id: "b", read: true }),
      expect.objectContaining({ id: "c", read: true }),
    ]);
  });

  it("writes nothing when there is nothing unread", async () => {
    mockLrange.mockResolvedValue([stored("a", true), stored("b", true)]);

    await markInboxNotifications("user-1", { all: true });

    expect(mockRpush).not.toHaveBeenCalled();
  });

  it("writes nothing when no entry matches", async () => {
    await markInboxNotifications("user-1", { ids: ["not-here"] });

    expect(mockRpush).not.toHaveBeenCalled();
  });

  it("skips a stored line that is not an entry", async () => {
    mockLrange.mockResolvedValue(["{ not json", stored("b", false)]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const entries = await listInboxNotifications("user-1");

    expect(entries.map((entry) => entry.id)).toEqual(["b"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
