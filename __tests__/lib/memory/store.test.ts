import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    memory: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import * as db from "@/lib/db";
import {
  createMemory,
  deleteMemory,
  findMemoryByTitle,
  normalizeCollection,
  normalizeTags,
  serializeMemory,
  updateMemory,
} from "@/lib/memory/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMemory = db.prisma.memory as any;

function makeMemory(overrides = {}) {
  return {
    id: "mem-1",
    userId: "user-123",
    collection: "facts",
    title: "User prefers dark mode",
    content: "The user prefers dark mode.",
    tags: ["ui"],
    source: null,
    accessCount: 3,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("memory store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalization", () => {
    it("trims and lowercases collections", () => {
      expect(normalizeCollection("  Preferences ")).toBe("preferences");
    });

    it("trims, lowercases, de-duplicates and drops empty tags", () => {
      expect(normalizeTags([" UI ", "ui", "", "  ", "Work"])).toEqual(["ui", "work"]);
      expect(normalizeTags(undefined)).toEqual([]);
    });
  });

  describe("serializeMemory", () => {
    it("exposes dates as ISO strings and keeps every field", () => {
      const serialized = serializeMemory(makeMemory());

      expect(serialized.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(serialized.updatedAt).toBe("2025-01-02T00:00:00.000Z");
      expect(serialized).toMatchObject({
        id: "mem-1",
        collection: "facts",
        title: "User prefers dark mode",
        tags: ["ui"],
        source: null,
        accessCount: 3,
      });
    });
  });

  describe("createMemory", () => {
    it("normalizes the draft before writing", async () => {
      mockMemory.create.mockResolvedValue(makeMemory());

      await createMemory("user-123", {
        collection: " Facts ",
        title: "  Title  ",
        content: "  Body  ",
        tags: [" A ", "a"],
      });

      expect(mockMemory.create).toHaveBeenCalledWith({
        data: {
          userId: "user-123",
          collection: "facts",
          title: "Title",
          content: "Body",
          tags: ["a"],
        },
      });
    });
  });

  describe("findMemoryByTitle", () => {
    it("scopes the lookup to the user and normalizes the collection", async () => {
      mockMemory.findFirst.mockResolvedValue(null);

      await findMemoryByTitle("user-123", " Facts ", "  Title ");

      expect(mockMemory.findFirst).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
          collection: "facts",
          title: { equals: "Title", mode: "insensitive" },
        },
      });
    });
  });

  describe("updateMemory", () => {
    it("returns null and writes nothing when the memory is not the user's", async () => {
      mockMemory.findFirst.mockResolvedValue(null);

      const result = await updateMemory("user-123", "mem-1", { title: "New" });

      expect(result).toBeNull();
      expect(mockMemory.update).not.toHaveBeenCalled();
    });

    it("skips the write when the patch carries no fields", async () => {
      const existing = makeMemory();
      mockMemory.findFirst.mockResolvedValue(existing);

      const result = await updateMemory("user-123", "mem-1", {});

      expect(result).toBe(existing);
      expect(mockMemory.update).not.toHaveBeenCalled();
    });

    it("scopes the update to the user and only sends supplied fields", async () => {
      mockMemory.findFirst.mockResolvedValue(makeMemory());
      mockMemory.update.mockResolvedValue(makeMemory({ title: "New" }));

      await updateMemory("user-123", "mem-1", { title: " New " });

      expect(mockMemory.update).toHaveBeenCalledWith({
        where: { id: "mem-1", userId: "user-123" },
        data: { title: "New" },
      });
    });
  });

  describe("deleteMemory", () => {
    it("reports whether a row was removed", async () => {
      mockMemory.deleteMany.mockResolvedValueOnce({ count: 1 });
      expect(await deleteMemory("user-123", "mem-1")).toBe(true);

      mockMemory.deleteMany.mockResolvedValueOnce({ count: 0 });
      expect(await deleteMemory("user-123", "mem-1")).toBe(false);

      expect(mockMemory.deleteMany).toHaveBeenCalledWith({
        where: { id: "mem-1", userId: "user-123" },
      });
    });
  });
});
