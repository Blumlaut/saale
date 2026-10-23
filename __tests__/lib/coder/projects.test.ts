import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Projects are a repo in the user's workspace plus a row.
 *
 * Git runs in the container, so the module is mocked here and the tests assert
 * what the app asks git to do, in which directory, and what the row looks like
 * when git refuses. A clone that fails must leave nothing behind: no row, no
 * half-project in the list.
 */

const {
  mockUserFindUnique,
  mockProjectFindMany,
  mockProjectFindFirst,
  mockProjectCreate,
  mockInitRepo,
  mockCloneRepo,
  mockRunGit,
  mockWriteWorkspaceFile,
  mockEnsureGitconfig,
  GitError,
} = vi.hoisted(() => {
  class GitError extends Error {
    readonly args: readonly string[];
    readonly result: { stdout: string; stderr: string; exitCode: number };

    constructor(
      message: string,
      args: readonly string[] = [],
      result: { stdout: string; stderr: string; exitCode: number } = {
        stdout: "",
        stderr: "",
        exitCode: 1,
      },
    ) {
      super(message);
      this.name = "GitError";
      this.args = args;
      this.result = result;
    }
  }

  return {
    mockUserFindUnique: vi.fn(),
    mockProjectFindMany: vi.fn(),
    mockProjectFindFirst: vi.fn(),
    mockProjectCreate: vi.fn(),
    mockInitRepo: vi.fn(),
    mockCloneRepo: vi.fn(),
    mockRunGit: vi.fn(),
    mockWriteWorkspaceFile: vi.fn(),
    mockEnsureGitconfig: vi.fn(),
    GitError,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    coderProject: {
      findMany: mockProjectFindMany,
      findFirst: mockProjectFindFirst,
      create: mockProjectCreate,
    },
  },
}));

vi.mock("@/lib/coder/git", () => ({
  GitError,
  initRepo: mockInitRepo,
  cloneRepo: mockCloneRepo,
  runGit: mockRunGit,
}));

vi.mock("@/lib/coder/gitconfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/gitconfig")>()),
  ensureGitconfig: mockEnsureGitconfig,
}));

vi.mock("@/lib/sandbox/workspace", () => ({
  userWorkspacePath: (userId: string) => `/workspaces/user-${userId}`,
  writeWorkspaceFile: mockWriteWorkspaceFile,
  writeOwned: vi.fn(),
}));

import {
  CoderProjectError,
  DEFAULT_GITIGNORE,
  createProject,
  getProject,
  listProjects,
} from "@/lib/coder/projects";

const USER = "user-1";
const NOW = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockUserFindUnique.mockResolvedValue({
    name: "Ada Lovelace",
    username: "ada",
    email: "ada@example.com",
  });
  mockProjectFindMany.mockResolvedValue([]);
  mockEnsureGitconfig.mockResolvedValue(`/workspaces/user-${USER}/.gitconfig`);
  mockInitRepo.mockResolvedValue(undefined);
  mockCloneRepo.mockResolvedValue(undefined);
  mockRunGit.mockResolvedValue({ stdout: "main\n", stderr: "", exitCode: 0 });
  mockWriteWorkspaceFile.mockResolvedValue("unused");
  mockProjectCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "project-1", createdAt: NOW, updatedAt: NOW, ...data }),
  );
});

describe("createProject: init", () => {
  it("inits a repo and stores projects/<slug>", async () => {
    const project = await createProject(USER, { name: "Saale Web" });

    expect(project.slug).toBe("saale-web");
    expect(project.repoPath).toBe("projects/saale-web");
    expect(project.defaultBranch).toBe("main");
    expect(mockInitRepo).toHaveBeenCalledWith(USER, {
      dir: "projects/saale-web",
      defaultBranch: "main",
    });
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });

  it("writes the default .gitignore into the new repo and commits it", async () => {
    await createProject(USER, { name: "saale-web" });

    expect(mockWriteWorkspaceFile).toHaveBeenCalledWith(
      USER,
      "projects/saale-web/.gitignore",
      expect.any(Buffer),
    );
    const written = mockWriteWorkspaceFile.mock.calls[0]![2] as Buffer;
    expect(written.toString("utf8")).toBe(DEFAULT_GITIGNORE);
    expect(DEFAULT_GITIGNORE).toContain("node_modules/");
    expect(DEFAULT_GITIGNORE).toContain(".env.*");
    // Committed, because a worktree branches from a commit and has to carry
    // the ignore file with it.
    expect(mockRunGit).toHaveBeenCalledWith(USER, {
      cwd: "projects/saale-web",
      args: ["add", "--", ".gitignore"],
    });
    expect(mockRunGit).toHaveBeenCalledWith(USER, {
      cwd: "projects/saale-web",
      args: ["commit", "-m", "Add .gitignore"],
    });
  });

  it("writes the git identity before the first git command", async () => {
    await createProject(USER, { name: "saale-web" });

    expect(mockEnsureGitconfig).toHaveBeenCalledWith(USER, {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(mockEnsureGitconfig.mock.invocationCallOrder[0]!).toBeLessThan(
      mockInitRepo.mock.invocationCallOrder[0]!,
    );
  });

  it("takes the next free slug when the name is taken", async () => {
    mockProjectFindMany.mockResolvedValue([{ slug: "api" }]);

    const project = await createProject(USER, { name: "api" });

    expect(project.slug).toBe("api-2");
    expect(project.repoPath).toBe("projects/api-2");
    expect(mockInitRepo).toHaveBeenCalledWith(USER, {
      dir: "projects/api-2",
      defaultBranch: "main",
    });
  });

  it("retries with the next slug when a racing create takes it", async () => {
    mockProjectFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ slug: "race" }]);
    mockProjectCreate.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const project = await createProject(USER, { name: "race" });

    expect(project.slug).toBe("race-2");
    // the repo is already on disk under the first slug, so it is not re-created
    expect(project.repoPath).toBe("projects/race");
    expect(mockProjectCreate).toHaveBeenCalledTimes(2);
    expect(mockInitRepo).toHaveBeenCalledTimes(1);
  });

  it("refuses a blank name before touching git", async () => {
    await expect(createProject(USER, { name: "   " })).rejects.toBeInstanceOf(CoderProjectError);
    expect(mockInitRepo).not.toHaveBeenCalled();
    expect(mockProjectCreate).not.toHaveBeenCalled();
  });
});

describe("createProject: clone", () => {
  it("clones and records the branch the repo was checked out on", async () => {
    mockRunGit.mockResolvedValue({ stdout: "develop\n", stderr: "", exitCode: 0 });

    const project = await createProject(USER, {
      name: "acme-api",
      cloneUrl: "https://github.com/acme/api.git",
      authFromEnv: true,
    });

    expect(mockCloneRepo).toHaveBeenCalledWith(USER, {
      dir: "projects/acme-api",
      url: "https://github.com/acme/api.git",
      authFromEnv: true,
    });
    expect(mockRunGit).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        cwd: "projects/acme-api",
        args: ["symbolic-ref", "--short", "HEAD"],
      }),
    );
    expect(project.defaultBranch).toBe("develop");
    expect(project.originUrl).toBe("https://github.com/acme/api.git");
    // a clone already has whatever the repo tracks; no .gitignore is added
    expect(mockWriteWorkspaceFile).not.toHaveBeenCalled();
    expect(mockInitRepo).not.toHaveBeenCalled();
  });

  it("falls back to main when the clone is on a detached HEAD", async () => {
    mockRunGit.mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });

    const project = await createProject(USER, {
      name: "acme",
      cloneUrl: "git@github.com:acme/api.git",
    });

    expect(project.defaultBranch).toBe("main");
    expect(mockCloneRepo).toHaveBeenCalledWith(USER, {
      dir: "projects/acme",
      url: "git@github.com:acme/api.git",
      authFromEnv: false,
    });
  });

  it("surfaces git's message and creates no row when the clone fails", async () => {
    mockCloneRepo.mockRejectedValue(
      new GitError(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    );

    const error = await createProject(USER, {
      name: "private",
      cloneUrl: "https://github.com/acme/private.git",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoderProjectError);
    expect((error as CoderProjectError).status).toBe(502);
    expect((error as CoderProjectError).message).toMatch(/could not read Username/);
    expect(mockProjectCreate).not.toHaveBeenCalled();
    expect(mockWriteWorkspaceFile).not.toHaveBeenCalled();
  });

  it("refuses a clone URL carrying whitespace", async () => {
    await expect(
      createProject(USER, { name: "x", cloneUrl: "https://github.com/a b.git" }),
    ).rejects.toBeInstanceOf(CoderProjectError);
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });
});

describe("listProjects", () => {
  it("scopes by user and counts active worktrees only", async () => {
    mockProjectFindMany.mockResolvedValue([
      {
        id: "p1",
        name: "One",
        slug: "one",
        repoPath: "projects/one",
        defaultBranch: "main",
        worktrees: [{ id: "w1" }, { id: "w2" }],
        _count: { chats: 3 },
        chats: [{ lastActivityAt: NOW }],
      },
      {
        id: "p2",
        name: "Two",
        slug: "two",
        repoPath: "projects/two",
        defaultBranch: "trunk",
        worktrees: [],
        _count: { chats: 0 },
        chats: [],
      },
    ]);

    const projects = await listProjects(USER);

    const args = mockProjectFindMany.mock.calls[0]![0] as {
      where: { userId: string };
      orderBy: { updatedAt: string };
      select: { worktrees: { where: { status: string } } };
    };
    expect(args.where).toEqual({ userId: USER });
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
    expect(args.select.worktrees.where).toEqual({ status: "active" });

    expect(projects).toEqual([
      {
        id: "p1",
        name: "One",
        slug: "one",
        repoPath: "projects/one",
        defaultBranch: "main",
        worktreeCount: 2,
        chatCount: 3,
        lastActivityAt: NOW,
      },
      {
        id: "p2",
        name: "Two",
        slug: "two",
        repoPath: "projects/two",
        defaultBranch: "trunk",
        worktreeCount: 0,
        chatCount: 0,
        lastActivityAt: null,
      },
    ]);
  });
});

describe("getProject", () => {
  it("returns null for a project of another user", async () => {
    mockProjectFindFirst.mockResolvedValue(null);

    expect(await getProject(USER, "someone-elses")).toBeNull();
    expect(mockProjectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-elses", userId: USER } }),
    );
  });

  it("maps each chat with its worktree state", async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: "p1",
      name: "One",
      slug: "one",
      repoPath: "projects/one",
      originUrl: "https://github.com/acme/one.git",
      defaultBranch: "main",
      chats: [
        {
          id: "c1",
          title: "Fix the build",
          lastActivityAt: NOW,
          coderWorktree: { path: "worktrees/one/c-abc", branch: "wt/c-abc", status: "active" },
        },
        { id: "c2", title: "New Chat", lastActivityAt: NOW, coderWorktree: null },
      ],
    });

    const project = await getProject(USER, "p1");

    expect(project).not.toBeNull();
    expect(project?.originUrl).toBe("https://github.com/acme/one.git");
    expect(project?.chats).toEqual([
      {
        id: "c1",
        title: "Fix the build",
        lastActivityAt: NOW,
        worktree: { path: "worktrees/one/c-abc", branch: "wt/c-abc", status: "active" },
      },
      { id: "c2", title: "New Chat", lastActivityAt: NOW, worktree: null },
    ]);
  });
});
