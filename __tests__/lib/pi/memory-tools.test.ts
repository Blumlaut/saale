import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma  $queryRaw is needed for the full-text search path
vi.mock("@/lib/db", () => ({
  prisma: {
    memory: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    expect(names).toContain("memory_create");
    expect(names).toContain("memory_update");
    expect(names).toContain("memory_delete");
  });

  describe("memory_index", () => {
    it("returns collections with counts, top tags, and recent titles", async () => {
      const tools = createMemoryTools(userId);
      const index = tools.find((t) => t.name === "memory_index")!;

      mockMemory.groupBy.mockResolvedValue([
        { collection: "facts", _count: { id: 5 } },
        { collection: "preferences", _count: { id: 2 } },
      ]);

      // Batched tags across collections
      mockQueryRaw.mockResolvedValueOnce([
        { collection: "facts", tag: "ui", count: 3 },
        { collection: "preferences", tag: "settings", count: 1 },
      ]);

      // Batched recent titles across collections
      mockMemory.findMany.mockResolvedValueOnce([
        { collection: "facts", title: "Dark mode pref" },
        { collection: "facts", title: "Font size pref" },
        { collection: "preferences", title: "API key fact" },
      ]);

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

      // The value a codemode script or watcher tick receives: no parsing, and no
      // UI metadata mixed in.
      expect(result.structuredContent).toEqual(text);
      expect(search.outputSchema).toBeDefined();
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

      // The LIMIT clause is passed to $queryRaw  verify the call was made
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

  describe("memory_create", () => {
    it("creates a memory and normalizes collection and tags", async () => {
      const tools = createMemoryTools(userId);
      const create = tools.find((t) => t.name === "memory_create")!;

      mockMemory.findFirst.mockResolvedValue(null);
      mockMemory.create.mockResolvedValue(
        makeMemory({ collection: "preferences", title: "Likes dark mode" }),
      );

      const result = await callExecute(create.execute, {
        collection: "  Preferences ",
        title: "  Likes dark mode  ",
        content: "  Prefers dark UI themes.  ",
        tags: ["UI", " ui ", ""],
      });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.created).toBe(true);
      expect(text.memory.id).toBe("mem-1");
      expect(mockMemory.create).toHaveBeenCalledWith({
        data: {
          userId,
          collection: "preferences",
          title: "Likes dark mode",
          content: "Prefers dark UI themes.",
          tags: ["ui"],
        },
      });
    });

    it("reports the existing memory instead of creating a duplicate title", async () => {
      const tools = createMemoryTools(userId);
      const create = tools.find((t) => t.name === "memory_create")!;

      const existing = makeMemory({ collection: "preferences", title: "Likes dark mode" });
      mockMemory.findFirst.mockResolvedValue(existing);

      const result = await callExecute(create.execute, {
        collection: "preferences",
        title: "likes dark mode",
        content: "duplicate",
      });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.created).toBe(false);
      expect(text.memory.id).toBe(existing.id);
      expect(mockMemory.findFirst).toHaveBeenCalledWith({
        where: {
          userId,
          collection: "preferences",
          title: { equals: "likes dark mode", mode: "insensitive" },
        },
      });
      expect(mockMemory.create).not.toHaveBeenCalled();
    });

    it("rejects a blank required field", async () => {
      const tools = createMemoryTools(userId);
      const create = tools.find((t) => t.name === "memory_create")!;

      await expect(
        callExecute(create.execute, { collection: "facts", title: "X", content: "   " }),
      ).rejects.toThrow("collection, title and content are required");
      expect(mockMemory.create).not.toHaveBeenCalled();
    });
  });

  describe("memory_update", () => {
    it("updates only the supplied fields, scoped to the user", async () => {
      const tools = createMemoryTools(userId);
      const update = tools.find((t) => t.name === "memory_update")!;

      mockMemory.findFirst.mockResolvedValue(makeMemory());
      mockMemory.update.mockResolvedValue(makeMemory({ title: "Renamed", tags: ["one"] }));

      const result = await callExecute(update.execute, {
        id: "mem-1",
        title: "  Renamed  ",
        tags: ["One", "one"],
      });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.updated).toBe(true);
      expect(text.memory.title).toBe("Renamed");
      expect(mockMemory.findFirst).toHaveBeenCalledWith({ where: { id: "mem-1", userId } });
      expect(mockMemory.update).toHaveBeenCalledWith({
        where: { id: "mem-1", userId },
        data: { title: "Renamed", tags: ["one"] },
      });
    });

    it("throws when the memory is not the user's", async () => {
      const tools = createMemoryTools(userId);
      const update = tools.find((t) => t.name === "memory_update")!;

      mockMemory.findFirst.mockResolvedValue(null);

      await expect(
        callExecute(update.execute, { id: "someone-elses", content: "x" }),
      ).rejects.toThrow("Memory someone-elses not found");
      expect(mockMemory.update).not.toHaveBeenCalled();
    });

    it("rejects an empty patch", async () => {
      const tools = createMemoryTools(userId);
      const update = tools.find((t) => t.name === "memory_update")!;

      await expect(callExecute(update.execute, { id: "mem-1" })).rejects.toThrow(
        "Provide at least one field to update",
      );
      expect(mockMemory.findFirst).not.toHaveBeenCalled();
    });

    it("rejects a blank replacement value", async () => {
      const tools = createMemoryTools(userId);
      const update = tools.find((t) => t.name === "memory_update")!;

      await expect(callExecute(update.execute, { id: "mem-1", title: "  " })).rejects.toThrow(
        "title cannot be empty",
      );
      expect(mockMemory.update).not.toHaveBeenCalled();
    });
  });

  describe("memory_delete", () => {
    it("deletes an owned memory and reports it", async () => {
      const tools = createMemoryTools(userId);
      const del = tools.find((t) => t.name === "memory_delete")!;

      mockMemory.findFirst.mockResolvedValue(
        makeMemory({ id: "mem-1", collection: "preferences", title: "User prefers dark mode" }),
      );
      mockMemory.deleteMany.mockResolvedValue({ count: 1 });

      const result = await callExecute(del.execute, { id: "mem-1" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.deleted).toBe(true);
      expect(text.id).toBe("mem-1");
      expect(text.title).toBe("User prefers dark mode");
      // Both the ownership read and the delete are scoped to the user.
      expect(mockMemory.findFirst).toHaveBeenCalledWith({ where: { id: "mem-1", userId } });
      expect(mockMemory.deleteMany).toHaveBeenCalledWith({ where: { id: "mem-1", userId } });
    });

    it("throws and deletes nothing when the memory is not the user's", async () => {
      const tools = createMemoryTools(userId);
      const del = tools.find((t) => t.name === "memory_delete")!;

      // findFirst is user-scoped, so another user's memory reads as missing.
      mockMemory.findFirst.mockResolvedValue(null);

      await expect(callExecute(del.execute, { id: "someone-elses" })).rejects.toThrow(
        "Memory someone-elses not found",
      );
      expect(mockMemory.deleteMany).not.toHaveBeenCalled();
    });
  });
});
