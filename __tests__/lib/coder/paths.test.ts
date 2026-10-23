import { describe, expect, it } from "vitest";
import {
  coderPathRelativeTo,
  coderWorkspaceRoot,
  projectRepoPath,
  resolveCoderPath,
  worktreePath,
} from "@/lib/coder/paths";

const USER = "user-1";

describe("coder paths", () => {
  it("stores the repo and worktree relative to the workspace", () => {
    expect(projectRepoPath("saale-web")).toBe("projects/saale-web");
    expect(worktreePath("saale-web", "3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(
      "worktrees/saale-web/c-3f2504e0",
    );
  });

  it("refuses a slug that could climb out of the directory", () => {
    expect(() => projectRepoPath("../escape")).toThrow();
    expect(() => worktreePath("../escape", "3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toThrow();
    expect(() => projectRepoPath("")).toThrow();
  });

  it("sanitizes a chat id rather than trusting it as a directory name", () => {
    expect(worktreePath("saale", "../escape")).toBe("worktrees/saale/c-escape");
  });

  it("resolves a stored path inside the user's workspace", () => {
    const root = coderWorkspaceRoot(USER);
    expect(resolveCoderPath(USER, "worktrees/x/c-1")).toBe(`${root}/worktrees/x/c-1`);
    expect(resolveCoderPath(USER, "projects/x")).toBe(`${root}/projects/x`);
  });

  it("refuses a stored path that leaves the workspace", () => {
    expect(() => resolveCoderPath(USER, "../other-user/projects/x")).toThrow();
    expect(() => resolveCoderPath(USER, "/etc")).toThrow();
    expect(() => resolveCoderPath(USER, "projects/../../etc")).toThrow();
  });

  it("reports the relative form of an absolute path", () => {
    const root = coderWorkspaceRoot(USER);
    expect(coderPathRelativeTo(USER, `${root}/worktrees/a/c-1`)).toBe("worktrees/a/c-1");
    expect(coderPathRelativeTo(USER, "/etc/passwd")).toBeNull();
  });
});
