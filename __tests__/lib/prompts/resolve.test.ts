import { describe, expect, it } from "vitest";

import {
  expandPrompt,
  mergePromptEntries,
  promptPickerItems,
  scopedPromptEntries,
  type PromptEntry,
} from "@/lib/prompts/resolve";

function entry(overrides: Partial<PromptEntry> = {}): PromptEntry {
  return {
    name: "review",
    description: "Review the staged changes",
    argumentHint: "[focus]",
    content: "Review the staged changes. Focus on ${1:-correctness}.",
    source: "user",
    ...overrides,
  };
}

describe("scopedPromptEntries", () => {
  const prompts = [
    { name: "any", description: "", argumentHint: null, scope: "any", content: "a" },
    { name: "chatty", description: "", argumentHint: null, scope: "chat", content: "b" },
    { name: "coderly", description: "", argumentHint: null, scope: "coder", content: "c" },
    { name: "junk", description: "", argumentHint: null, scope: "nonsense", content: "d" },
  ];

  it("offers every prompt but the other surface's in a normal chat", () => {
    expect(scopedPromptEntries(prompts, false).map((p) => p.name)).toEqual([
      "any",
      "chatty",
      "junk",
    ]);
  });

  it("offers every prompt but the other surface's in a coder chat", () => {
    expect(scopedPromptEntries(prompts, true).map((p) => p.name)).toEqual([
      "any",
      "coderly",
      "junk",
    ]);
  });

  it("marks the rows as the user's own", () => {
    expect(scopedPromptEntries(prompts, false).every((p) => p.source === "user")).toBe(true);
  });
});

describe("mergePromptEntries", () => {
  it("lets the earlier list own a name", () => {
    const merged = mergePromptEntries(
      [entry({ source: "user", content: "mine" })],
      [
        entry({ source: "project", content: "theirs" }),
        entry({ name: "other", source: "project" }),
      ],
    );
    expect(merged.map((p) => p.name)).toEqual(["review", "other"]);
    expect(merged[0]?.content).toBe("mine");
  });
});

describe("promptPickerItems", () => {
  it("drops the content the composer does not need", () => {
    expect(promptPickerItems([entry()])).toEqual([
      {
        name: "review",
        description: "Review the staged changes",
        argumentHint: "[focus]",
        source: "user",
      },
    ]);
  });
});

describe("expandPrompt", () => {
  it("fills the placeholders from the arguments typed after the name", () => {
    const match = expandPrompt("/review security", [entry()]);
    expect(match?.entry.name).toBe("review");
    expect(match?.content).toBe("Review the staged changes. Focus on security.");
  });

  it("uses the default when no arguments are given", () => {
    expect(expandPrompt("/review", [entry()])?.content).toBe(
      "Review the staged changes. Focus on correctness.",
    );
  });

  it("ignores a name no prompt answers to", () => {
    expect(expandPrompt("/unknown", [entry()])).toBeNull();
  });

  it("ignores text that is not a command", () => {
    expect(expandPrompt("review the diff", [entry()])).toBeNull();
  });

  it("matches a name despite its case", () => {
    expect(expandPrompt("/Review", [entry()])?.entry.name).toBe("review");
  });
});
