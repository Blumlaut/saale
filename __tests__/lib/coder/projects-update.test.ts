import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A project's settings, and what saving them does to the checkouts.
 *
 * The env files are the reason this exists: a worktree is its own checkout, so
 * the files have to be handed to it. Saving fills in the checkouts that are
 * already there without replacing what the agent wrote in them.
 */

const mocks = vi.hoisted(() => ({
  findProject: vi.fn(),
  updateProject: vi.fn(),
  findWorktrees: vi.fn(),
  runInWorkspace: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    coderProject: { findFirst: mocks.findProject, update: mocks.updateProject },
    coderWorktree: { findMany: mocks.findWorktrees },
  },
}));

vi.mock("@/lib/coder/git", () => ({
  GitError: class FakeGitError extends Error {},
  initRepo: vi.fn(),
  cloneRepo: vi.fn(),
  runGit: vi.fn(),
  runInWorkspace: mocks.runInWorkspace,
  shellQuote: (value: string) => `'${value}'`,
}));

vi.mock("@/lib/coder/gitconfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/gitconfig")>()),
  ensureGitconfig: vi.fn(),
}));

import { CoderProjectError, updateProject } from "@/lib/coder/projects";

const USER = "user-1";
const PROJECT_ID = "project-1";

let workspaceDir = "";
let originalWorkspacesDir: string | undefined;

function inWorkspace(relative: string): string {
  return path.join(workspaceDir, `user-${USER}`, relative);
}

/** The row as the query returns it: the settings themselves, nothing derived. */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    name: "Saale Web",
    slug: "saale-web",
    repoPath: "projects/saale-web",
    defaultBranch: "main",
    originUrl: null,
    envFiles: null,
    setupScript: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-projects-update-"));
  process.env.SANDBOX_WORKSPACES_DIR = workspaceDir;

  await fs.mkdir(inWorkspace("projects/saale-web/.git/info"), { recursive: true });
  await fs.writeFile(inWorkspace("projects/saale-web/.git/info/exclude"), "");
  await fs.mkdir(inWorkspace("worktrees/saale-web/c-1a2b3c4d"), { recursive: true });

  mocks.findProject.mockResolvedValue(projectRow());
  mocks.findWorktrees.mockResolvedValue([{ path: "worktrees/saale-web/c-1a2b3c4d" }]);
  mocks.updateProject.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(projectRow(data)),
  );
});

afterEach(async () => {
  process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("updateProject", () => {
  it("saves the fields it was given and leaves the rest alone", async () => {
    await updateProject(USER, PROJECT_ID, { name: "Saale" });

    expect(mocks.updateProject).toHaveBeenCalledWith({
      where: { id: PROJECT_ID },
      data: {
        name: "Saale",
        defaultBranch: "main",
        envFiles: [],
        setupScript: null,
      },
      select: expect.any(Object),
    });
  });

  it("refuses a branch name git could not check out", async () => {
    await expect(updateProject(USER, PROJECT_ID, { defaultBranch: "main..x" })).rejects.toThrow(
      CoderProjectError,
    );
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("refuses a project that is not this user's", async () => {
    mocks.findProject.mockResolvedValue(null);

    const error = await updateProject(USER, PROJECT_ID, { name: "Mine" }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CoderProjectError);
    expect((error as CoderProjectError).status).toBe(404);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("writes the env files into the checkouts that exist", async () => {
    await updateProject(USER, PROJECT_ID, {
      envFiles: [{ path: ".env.local", content: "DATABASE_URL=1\n" }],
    });

    expect(
      await fs.readFile(inWorkspace("worktrees/saale-web/c-1a2b3c4d/.env.local"), "utf8"),
    ).toBe("DATABASE_URL=1\n");
    expect(await fs.readFile(inWorkspace("projects/saale-web/.git/info/exclude"), "utf8")).toBe(
      "/.env.local\n",
    );
  });

  it("keeps the file a checkout already holds", async () => {
    await fs.writeFile(inWorkspace("worktrees/saale-web/c-1a2b3c4d/.env.local"), "EDITED=1\n");

    await updateProject(USER, PROJECT_ID, {
      envFiles: [
        { path: ".env.local", content: "DATABASE_URL=1\n" },
        { path: ".env", content: "SHARED=1\n" },
      ],
    });

    expect(
      await fs.readFile(inWorkspace("worktrees/saale-web/c-1a2b3c4d/.env.local"), "utf8"),
    ).toBe("EDITED=1\n");
    expect(await fs.readFile(inWorkspace("worktrees/saale-web/c-1a2b3c4d/.env"), "utf8")).toBe(
      "SHARED=1\n",
    );
  });

  it("keeps a script that is blank out of the column", async () => {
    await updateProject(USER, PROJECT_ID, { setupScript: "\n  \n" });

    expect(mocks.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ setupScript: null }) }),
    );
  });
});
