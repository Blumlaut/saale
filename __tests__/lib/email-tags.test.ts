import { describe, it, expect } from "vitest";
import { getTagColor, collectTags } from "@/lib/email/tags";

describe("getTagColor", () => {
  it("returns a valid Tailwind class string", () => {
    const color = getTagColor("work");
    expect(color).toBeTypeOf("string");
    expect(color.length).toBeGreaterThan(0);
    expect(color).toContain("bg-");
    expect(color).toContain("text-");
  });

  it("is deterministic  same tag always returns same color", () => {
    const color1 = getTagColor("finance");
    const color2 = getTagColor("finance");
    const color3 = getTagColor("finance");

    expect(color1).toBe(color2);
    expect(color2).toBe(color3);
  });

  it("returns different colors for different tags (most of the time)", () => {
    const tags = ["work", "personal", "finance", "travel", "health", "news"];
    const colors = new Set(tags.map(getTagColor));

    // With 8 palette entries and 6 tags, we should get at least 3 distinct colors
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it("handles empty string", () => {
    const color = getTagColor("");
    expect(typeof color).toBe("string");
    expect(color.length).toBeGreaterThan(0);
  });

  it("handles unicode tag names", () => {
    const color = getTagColor("café");
    expect(typeof color).toBe("string");
    expect(color.length).toBeGreaterThan(0);
  });

  it("handles very long tag names", () => {
    const longTag = "a".repeat(1000);
    const color = getTagColor(longTag);
    expect(typeof color).toBe("string");
    expect(color.length).toBeGreaterThan(0);
  });

  it("uses both light and dark mode classes", () => {
    const color = getTagColor("test");
    // Each color string contains both light and dark variants separated by " dark:"
    expect(color).toContain("dark:");
  });
});

describe("collectTags", () => {
  it("returns empty array for messages with no tags", () => {
    const messages = [
      { id: "1", tags: [] },
      { id: "2", tags: [] },
    ];
    const result = collectTags(messages);
    expect(result).toEqual([]);
  });

  it("collects unique tags with correct counts", () => {
    const messages = [
      { id: "1", tags: ["work", "urgent"] },
      { id: "2", tags: ["personal"] },
      { id: "3", tags: ["work", "finance"] },
      { id: "4", tags: ["work"] },
    ];
    const result = collectTags(messages);

    expect(result).toEqual([
      { name: "work", count: 3 },
      { name: "urgent", count: 1 },
      { name: "personal", count: 1 },
      { name: "finance", count: 1 },
    ]);
  });

  it("sorts by count descending", () => {
    const messages = [
      { id: "1", tags: ["rare"] },
      { id: "2", tags: ["common", "common"] }, // duplicate in same message counts twice
      { id: "3", tags: ["common"] },
      { id: "4", tags: ["medium", "medium"] },
    ];
    const result = collectTags(messages);

    expect(result[0]!.name).toBe("common");
    expect(result[0]!.count).toBe(3);
    expect(result[1]!.name).toBe("medium");
    expect(result[1]!.count).toBe(2);
    expect(result[2]!.name).toBe("rare");
    expect(result[2]!.count).toBe(1);
  });

  it("handles empty message list", () => {
    const result = collectTags([]);
    expect(result).toEqual([]);
  });

  it("handles messages with duplicate tags in same message", () => {
    const messages = [{ id: "1", tags: ["work", "work", "work"] }];
    const result = collectTags(messages);

    // Each occurrence counts separately
    expect(result).toEqual([{ name: "work", count: 3 }]);
  });

  it("is case-sensitive", () => {
    const messages = [
      { id: "1", tags: ["Work"] },
      { id: "2", tags: ["work"] },
    ];
    const result = collectTags(messages);

    expect(result.length).toBe(2);
    expect(result.find((t) => t.name === "Work")!).toBeDefined();
    expect(result.find((t) => t.name === "work")!).toBeDefined();
  });
});
