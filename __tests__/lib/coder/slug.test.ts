import { describe, expect, it } from "vitest";
import {
  coderBranchName,
  coderChatSlug,
  isCoderSlug,
  isWorktreeBranch,
  repoSlugFromUrl,
  toCoderSlug,
  uniqueSlug,
  watcherBranchName,
} from "@/lib/coder/slug";

describe("coder slugs", () => {
  it("lowercases, dashes and trims a display name", () => {
    expect(toCoderSlug("Saale Web")).toBe("saale-web");
    expect(toCoderSlug("  Über Project!  ")).toBe("uber-project");
    expect(toCoderSlug("a___b")).toBe("a-b");
  });

  it("never returns an empty slug", () => {
    expect(toCoderSlug("...")).toBe("project");
    expect(toCoderSlug("")).toBe("project");
    expect(toCoderSlug("///")).toBe("project");
  });

  it("keeps the slug inside the filesystem and git rules", () => {
    expect(isCoderSlug("saale-web")).toBe(true);
    expect(isCoderSlug("-leading")).toBe(false);
    expect(isCoderSlug("Upper")).toBe(false);
    expect(isCoderSlug("with/slash")).toBe(false);
    expect(isCoderSlug("..")).toBe(false);
    expect(isCoderSlug("a".repeat(61))).toBe(false);
  });

  it("takes a clone's name from its URL", () => {
    expect(repoSlugFromUrl("https://github.com/Blumlaut/saale.git")).toBe("saale");
    expect(repoSlugFromUrl("git@github.com:Blumlaut/saale.git")).toBe("saale");
    expect(repoSlugFromUrl("https://github.com/Blumlaut/saale")).toBe("saale");
    expect(repoSlugFromUrl("https://github.com/Blumlaut/saale/")).toBe("saale");
    expect(repoSlugFromUrl("https://example.com")).toBe("example-com");
  });

  it("numbers a slug that is already taken", () => {
    expect(uniqueSlug("api", [])).toBe("api");
    expect(uniqueSlug("api", ["api"])).toBe("api-2");
    expect(uniqueSlug("api", ["api", "api-2"])).toBe("api-3");
  });

  it("derives a stable branch and worktree name from the chat", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(coderChatSlug(id)).toBe("c-3f2504e0");
    expect(coderChatSlug(id)).toBe(coderChatSlug(id));
    expect(coderBranchName(coderChatSlug(id))).toBe("wt/c-3f2504e0");
  });

  it("groups a watcher's fires under one branch prefix", () => {
    expect(watcherBranchName("pr-bot", "c-3f2504e0")).toBe("watch/pr-bot/c-3f2504e0");
    expect(watcherBranchName("pr-bot", "sticky")).toBe("watch/pr-bot/sticky");
    // A name that is not usable as a slug is refused rather than quoted.
    expect(() => watcherBranchName("PR bot!", "c-1")).toThrow(/Not a usable name/);
  });

  it("recognises only the branch names it could have produced", () => {
    expect(isWorktreeBranch("watch/pr-bot/c-3f2504e0")).toBe(true);
    expect(isWorktreeBranch("wt/c-3f2504e0")).toBe(true);
    expect(isWorktreeBranch("--upload-pack=evil")).toBe(false);
    expect(isWorktreeBranch("watch/../../etc")).toBe(false);
    expect(isWorktreeBranch("watch/pr-bot/")).toBe(false);
    expect(isWorktreeBranch("watch/pr-bot/c-1.lock")).toBe(false);
    expect(isWorktreeBranch("Upper/Case")).toBe(false);
  });
});
