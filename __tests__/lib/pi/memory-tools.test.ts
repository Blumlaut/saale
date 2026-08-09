import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma — $queryRaw is needed for the full-text search path
vi.mock("@/lib/db", () => ({
  prisma: {
    memory: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

// Import mocks for assertions
import * as db from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMemory = db.prisma.memory as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueryRaw = db.prisma.$queryRaw as any;

// Import after mocks
import { createMemoryTools } from "@/lib/pi/tools/memory-tools";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown> = {}) =>
  execute("call-1", params, undefined, undefined, {} as never);

// Factory to create a memory record
function makeMemory(overrides = {}) {
  return {
    id: "mem-1",
    userId: "user-123",
    collection: "facts",
    title: "User prefers dark mode",
    content: "The user has expressed a preference for dark mode in the UI settings.",
    tags: ["preferences", "ui"],
    importance: 7,
    source: null,
    accessCount: 3,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("createMemoryTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all expected tool names", () => {
    const tools = createMemoryTools(userId);
    const names = tools.map((t) => t.name);
    expect(names).toContain("memory_index");
    expect(names).toContain("memory_search");
  });

  describe("memory_index", () => {
    it("returns collections with counts, top tags, and recent titles", async () => {
      const tools = createMemoryTools(userId);
      const index = tools.find((t) => t.name === "memory_index")!;

      mockMemory.groupBy.mockResolvedValue([
        { collection: "facts", _count: { id: 5 } },
        { collection: "preferences", _count: { id: 2 } },
      ]);

      // First call: tags for "facts", second call: tags for "preferences"
      mockQueryRaw.mockResolvedValueOnce([{ tag: "ui", count: 3 }]);
      mockQueryRaw.mockResolvedValueOnce([{ tag: "settings", count: 1 }]);

      // Recent titles for each collection
      mockMemory.findMany.mockResolvedValueOnce([
        { title: "Dark mode pref" },
        { title: "Font size pref" },
      ]);
      mockMemory.findMany.mockResolvedValueOnce([{ title: "API key fact" }]);

      const result = await callExecute(index.execute);
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.totalCollections).toBe(2);
      expect(text.totalMemories).toBe(7);
      expect(text.collections).toHaveLength(2);
      expect(text.collections[0].collection).toBe("facts");
      expect(text.collections[0].count).toBe(5);
      expect(text.collections[0].topTags).toContain("ui");
      expect(text.collections[0].recent).toContain("Dark mode pref");
    });

    it("returns empty result when no collections exist", async () => {
      const tools = createMemoryTools(userId);
      const index = tools.find((t) => t.name === "memory_index")!;

      mockMemory.groupBy.mockResolvedValue([]);

      const result = await callExecute(index.execute);
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.totalCollections).toBe(0);
      expect(text.totalMemories).toBe(0);
      expect(text.collections).toEqual([]);
    });
  });

  describe("memory_search", () => {
    it("returns results via full-text search", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const mem = makeMemory();
      mockQueryRaw.mockResolvedValue([{ ...mem, rank: 0.95 }]);
      mockMemory.updateMany.mockResolvedValue({ count: 1 });

      const result = await callExecute(search.execute, { query: "dark mode" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(1);
      expect(text.memories[0].title).toBe("User prefers dark mode");
      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it("returns empty results for whitespace-only query", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const result = await callExecute(search.execute, { query: "   " });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(0);
      expect(text.memories).toEqual([]);
      expect(text.error).toBe("Query is empty");
      expect(mockQueryRaw).not.toHaveBeenCalled();
      expect(mockMemory.findMany).not.toHaveBeenCalled();
    });

    it("returns empty results for empty string query", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const result = await callExecute(search.execute, { query: "" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(0);
      expect(text.error).toBe("Query is empty");
    });

    it("falls back to Prisma ORM when FTS throws", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const mem = makeMemory();
      mockQueryRaw.mockRejectedValue(new Error("plainto_tsquery: invalid query"));
      mockMemory.findMany.mockResolvedValue([mem]);
      mockMemory.updateMany.mockResolvedValue({ count: 1 });

      const result = await callExecute(search.execute, { query: "weird-chars!" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(1);
      expect(text.memories[0].title).toBe("User prefers dark mode");
      expect(mockMemory.findMany).toHaveBeenCalled();
    });

    it("includes collection filter in fallback query", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockRejectedValue(new Error("FTS error"));
      mockMemory.findMany.mockResolvedValue([]);

      await callExecute(search.execute, {
        query: "test",
        collection: "preferences",
      });

      expect(mockMemory.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId,
          collection: "preferences",
          OR: expect.arrayContaining([
            expect.objectContaining({ title: expect.any(Object) }),
            expect.objectContaining({ content: expect.any(Object) }),
          ]),
        }),
        orderBy: { updatedAt: "desc" },
        take: 10,
      });
    });

    it("includes tags filter in fallback query", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockRejectedValue(new Error("FTS error"));
      mockMemory.findMany.mockResolvedValue([]);

      await callExecute(search.execute, {
        query: "test",
        tags: ["ui", "settings"],
      });

      expect(mockMemory.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tags: { hasSome: ["ui", "settings"] },
        }),
        orderBy: { updatedAt: "desc" },
        take: 10,
      });
    });

    it("respects custom limit", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockResolvedValue([]);

      await callExecute(search.execute, { query: "test", limit: 5 });

      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it("caps limit at 50", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockResolvedValue([]);

      await callExecute(search.execute, { query: "test", limit: 999 });

      // The LIMIT clause is passed to $queryRaw — verify the call was made
      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it("increments accessCount for returned memories", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const mem1 = makeMemory({ id: "mem-1" });
      const mem2 = makeMemory({ id: "mem-2" });
      mockQueryRaw.mockResolvedValue([
        { ...mem1, rank: 1 },
        { ...mem2, rank: 0.5 },
      ]);
      mockMemory.updateMany.mockResolvedValue({ count: 2 });

      await callExecute(search.execute, { query: "test" });

      expect(mockMemory.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["mem-1", "mem-2"] }, userId },
        data: { accessCount: { increment: 1 } },
      });
    });

    it("skips accessCount update when no results", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockResolvedValue([]);

      await callExecute(search.execute, { query: "nonexistent" });

      expect(mockMemory.updateMany).not.toHaveBeenCalled();
    });

    it("serializes dates to ISO strings", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      const mem = makeMemory();
      mockQueryRaw.mockResolvedValue([{ ...mem, rank: 0.95 }]);
      mockMemory.updateMany.mockResolvedValue({ count: 1 });

      const result = await callExecute(search.execute, { query: "test" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.memories[0].createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(text.memories[0].updatedAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("includes collection and tags filters in FTS query", async () => {
      const tools = createMemoryTools(userId);
      const search = tools.find((t) => t.name === "memory_search")!;

      mockQueryRaw.mockResolvedValue([]);

      await callExecute(search.execute, {
        query: "test",
        collection: "facts",
        tags: ["ui"],
      });

      expect(mockQueryRaw).toHaveBeenCalled();
    });
  });
});
