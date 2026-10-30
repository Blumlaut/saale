import { describe, expect, it } from "vitest";
import {
  isConflict,
  parseBranches,
  parseDiffTreeNameStatus,
  parseLog,
  parseNumstat,
  parsePorcelainZ,
  parseRemotes,
  parseStatusHeader,
  parseSymrefHead,
  parseWorktreeList,
} from "@/lib/coder/git-status";

/** Real `git status --porcelain=v1 -z -b` output: a rename, both sides of an
 * edit, a deletion and an untracked file. */
const STATUS =
  "## main\0 M blob.bin\0 D gone.txt\0RM renamed.txt\0keep.txt\0M  staged.txt\0?? untracked.txt\0";

describe("parsePorcelainZ", () => {
  it("reads staged, unstaged, deleted and untracked paths", () => {
    const files = parsePorcelainZ(STATUS);
    expect(files.map((file) => file.path)).toEqual([
      "blob.bin",
      "gone.txt",
      "renamed.txt",
      "staged.txt",
      "untracked.txt",
    ]);
    expect(files.find((file) => file.path === "staged.txt")).toMatchObject({
      index: "M",
      worktree: " ",
    });
    expect(files.find((file) => file.path === "untracked.txt")).toMatchObject({
      index: "?",
      worktree: "?",
    });
  });

  it("keeps a rename's origin, which git prints as its own record", () => {
    const renamed = parsePorcelainZ(STATUS).find((file) => file.path === "renamed.txt");
    expect(renamed?.originalPath).toBe("keep.txt");
    expect(renamed).toMatchObject({ index: "R", worktree: "M" });
  });

  it("does not read a path that looks like a status record as one", () => {
    const files = parsePorcelainZ("## main\0?? M odd name.txt\0");
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("M odd name.txt");
  });

  it("returns nothing for a clean tree", () => {
    expect(parsePorcelainZ("## main\0")).toEqual([]);
  });
});

describe("parseStatusHeader", () => {
  it("reads a branch that tracks an upstream", () => {
    expect(parseStatusHeader("## main...origin/main [ahead 1, behind 2]\0")).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
    });
  });

  it("reads a branch with no upstream", () => {
    expect(parseStatusHeader("## wt/c-1a2b3c4d\0")).toEqual({
      branch: "wt/c-1a2b3c4d",
      upstream: "",
      ahead: 0,
      behind: 0,
    });
  });

  it("reads a repo with no commits yet", () => {
    expect(parseStatusHeader("## No commits yet on main\0")).toEqual({
      branch: "main",
      upstream: "",
      ahead: 0,
      behind: 0,
    });
  });

  it("reports no branch in a detached HEAD", () => {
    expect(parseStatusHeader("## HEAD (no branch)\0")).toMatchObject({
      branch: "HEAD (no branch)",
    });
  });
});

describe("parseNumstat", () => {
  it("reads line counts, a binary file and a rename", () => {
    const Z = "\u0000";
    const stdout = `1\t1\tblob.bin${Z}0\t1\tgone.txt${Z}1\t1\t${Z}keep.txt${Z}renamed.txt${Z}1\t0\tstaged.txt${Z}`;
    const entries = parseNumstat(stdout);
    expect(entries).toEqual([
      { path: "blob.bin", added: 1, deleted: 1 },
      { path: "gone.txt", added: 0, deleted: 1 },
      { path: "renamed.txt", added: 1, deleted: 1, originalPath: "keep.txt" },
      { path: "staged.txt", added: 1, deleted: 0 },
    ]);
  });

  it("reports a binary file's counts as null", () => {
    const [entry] = parseNumstat("-\t-\timage.png\u0000");
    expect(entry).toMatchObject({ path: "image.png", added: null, deleted: null });
  });
});

describe("parseDiffTreeNameStatus", () => {
  it("reads adds, modifies and deletes as one entry per path", () => {
    const Z = "\u0000";
    const stdout = `A${Z}new.txt${Z}M${Z}src/a.ts${Z}D${Z}gone.txt${Z}`;
    expect(parseDiffTreeNameStatus(stdout)).toEqual([
      {
        path: "new.txt",
        originalPath: null,
        status: "A",
        added: null,
        deleted: null,
        baseRef: null,
      },
      {
        path: "src/a.ts",
        originalPath: null,
        status: "M",
        added: null,
        deleted: null,
        baseRef: null,
      },
      {
        path: "gone.txt",
        originalPath: null,
        status: "D",
        added: null,
        deleted: null,
        baseRef: null,
      },
    ]);
  });

  it("keeps a rename's origin, which git prints with a similarity score", () => {
    const [entry] = parseDiffTreeNameStatus("R100\u0000keep.txt\u0000renamed.txt\u0000");
    expect(entry).toMatchObject({ path: "renamed.txt", originalPath: "keep.txt", status: "R" });
  });

  it("skips records that are not statuses", () => {
    expect(parseDiffTreeNameStatus("src/a.ts\u0000A\u0000new.txt\u0000")).toEqual([
      {
        path: "new.txt",
        originalPath: null,
        status: "A",
        added: null,
        deleted: null,
        baseRef: null,
      },
    ]);
  });
});

describe("parseLog", () => {
  it("keeps the subject even when it holds a separator-like string", () => {
    const stdout = ["abc123\x1fabc123\x1f2026-10-23T10:51:21Z\x1fAda\x1fadd: a file\x1f", ""].join(
      "\x1e",
    );
    expect(parseLog(stdout)).toEqual([
      {
        sha: "abc123",
        shortSha: "abc123",
        date: "2026-10-23T10:51:21Z",
        author: "Ada",
        subject: "add: a file",
        refs: [],
      },
    ]);
  });

  it("reads what points at a commit, which is where a branch or a tag shows up", () => {
    const stdout = [
      "abc123\x1fabc123\x1f2026-10-23T10:51:21Z\x1fAda\x1frelease\x1fHEAD -> main, origin/main, tag: v1.2.0",
      "",
    ].join("\x1e");
    expect(parseLog(stdout)[0]?.refs).toEqual(["HEAD -> main", "origin/main", "tag: v1.2.0"]);
  });

  it("returns nothing for an empty repo", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("isConflict", () => {
  it("reads the unmerged codes a merge leaves behind", () => {
    expect(isConflict("U", "U")).toBe(true);
    expect(isConflict("A", "A")).toBe(true);
    expect(isConflict("D", "U")).toBe(true);
  });

  it("leaves an ordinary staged or unstaged change alone", () => {
    expect(isConflict("M", " ")).toBe(false);
    expect(isConflict(" ", "M")).toBe(false);
    expect(isConflict("A", " ")).toBe(false);
  });
});

describe("parseRemotes", () => {
  it("keeps one entry per remote, from its fetch line", () => {
    const stdout = [
      "origin\tgit@github.com:acme/saale.git (fetch)",
      "origin\tgit@github.com:acme/saale.git (push)",
      "upstream\thttps://github.com/other/saale.git (fetch)",
      "upstream\thttps://github.com/other/saale.git (push)",
    ].join("\n");
    expect(parseRemotes(stdout)).toEqual([
      { name: "origin", url: "git@github.com:acme/saale.git" },
      { name: "upstream", url: "https://github.com/other/saale.git" },
    ]);
  });

  it("returns nothing for a repo with no remote", () => {
    expect(parseRemotes("")).toEqual([]);
  });
});

describe("parseBranches", () => {
  it("reads the branch list with its upstream and which one is checked out", () => {
    const stdout = ["main\torigin/main\t*", "wt/abc\torigin/main\t ", "wt/old\t\t "].join("\n");
    expect(parseBranches(stdout)).toEqual([
      { name: "main", upstream: "origin/main", current: true },
      { name: "wt/abc", upstream: "origin/main", current: false },
      { name: "wt/old", upstream: "", current: false },
    ]);
  });
});

describe("parseWorktreeList", () => {
  it("marks the main worktree and reads branches", () => {
    const stdout = [
      "worktree /workspaces/user-1/projects/saale",
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      "worktree /workspaces/user-1/worktrees/saale/c-1a2b3c4d",
      "HEAD 2222",
      "branch refs/heads/wt/c-1a2b3c4d",
      "",
      "worktree /workspaces/user-1/worktrees/saale/c-gone",
      "HEAD 3333",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const worktrees = parseWorktreeList(stdout);
    expect(worktrees).toHaveLength(3);
    expect(worktrees[0]).toMatchObject({ branch: "main", main: true, prunable: false });
    expect(worktrees[1]).toMatchObject({ branch: "wt/c-1a2b3c4d", main: false });
    expect(worktrees[2]).toMatchObject({ branch: "", prunable: true });
  });
});

describe("parseSymrefHead", () => {
  it("reads the branch a remote's HEAD points at", () => {
    const out = `ref: refs/heads/develop\tHEAD\n${"1".repeat(40)}\tHEAD\n`;
    expect(parseSymrefHead(out)).toBe("develop");
  });

  it("is null when HEAD names a tag or nothing at all", () => {
    expect(parseSymrefHead(`${"1".repeat(40)}\tHEAD\n`)).toBeNull();
    expect(parseSymrefHead("")).toBeNull();
  });
});
