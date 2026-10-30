import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { readProjectPrompts } from "@/lib/prompts/project";

let root: string;

/** A template file inside a checkout's `.pi/prompts`. */
async function template(fileName: string, content: string): Promise<void> {
  const dir = path.join(root, ".pi", "prompts");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "saale-prompts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readProjectPrompts", () => {
  it("reads the description and argument hint from the frontmatter", async () => {
    await template(
      "review.md",
      [
        "---",
        "description: Review the staged changes",
        'argument-hint: "[focus]"',
        "---",
        "Review it.",
      ].join("\n"),
    );

    expect(await readProjectPrompts(root)).toEqual([
      {
        name: "review",
        description: "Review the staged changes",
        argumentHint: "[focus]",
        content: "Review it.",
        source: "project",
      },
    ]);
  });

  it("falls back to the first line for the description", async () => {
    await template("commit.md", "\n\nSplit the work into small commits.\n\nThen push.\n");

    const [prompt] = await readProjectPrompts(root);
    expect(prompt?.description).toBe("Split the work into small commits.");
    expect(prompt?.argumentHint).toBeNull();
  });

  it("ignores nested files, other extensions and names the parser cannot read", async () => {
    await template("review.md", "Review it.");
    await template("notes.txt", "not a template");
    await template("Not A Name.md", "uppercase name");
    await mkdir(path.join(root, ".pi", "prompts", "nested"), { recursive: true });
    await writeFile(path.join(root, ".pi", "prompts", "nested", "deep.md"), "deep");

    expect((await readProjectPrompts(root)).map((p) => p.name)).toEqual(["review"]);
  });

  it("returns nothing for a checkout without a prompts directory", async () => {
    expect(await readProjectPrompts(root)).toEqual([]);
    expect(await readProjectPrompts(null)).toEqual([]);
  });

  it("keeps a template whose description is too long within the column", async () => {
    await template("long.md", `---\ndescription: ${"x".repeat(150)}\n---\nBody`);

    const [prompt] = await readProjectPrompts(root);
    expect(prompt?.description.length).toBe(100);
    expect(prompt?.description.endsWith("…")).toBe(true);
  });
});
