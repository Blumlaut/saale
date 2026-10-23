import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectContextFiles, projectSkillPaths, sessionWorkspace } from "@/lib/pi/project-context";

/**
 * What a session inherits from its workspace.
 *
 * The rules are Pi's — override files, the `CLAUDE.md` fallback, one file per
 * directory. Saale's own rule is the boundary: the workspace is the whole tree
 * a session may read, so nothing above it reaches a prompt.
 */

const USER = "user-1";

let volumeDir = "";
let root = "";
let originalWorkspacesDir: string | undefined;

beforeEach(async () => {
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  volumeDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-project-context-"));
  process.env.SANDBOX_WORKSPACES_DIR = volumeDir;
  root = path.join(volumeDir, `user-${USER}`);
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  await fs.rm(volumeDir, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe("projectContextFiles", () => {
  it("reads the worktree's AGENTS.md", async () => {
    const worktree = path.join(root, "worktrees/saale/c-1");
    await write(path.join(worktree, "AGENTS.md"), "# Rules\nRun the tests.\n");

    const files = projectContextFiles(sessionWorkspace(USER, worktree));

    expect(files).toEqual([
      { path: path.join(worktree, "AGENTS.md"), content: "# Rules\nRun the tests.\n" },
    ]);
  });

  it("applies the workspace root first, then the worktree's own file", async () => {
    const worktree = path.join(root, "worktrees/saale/c-1");
    await write(path.join(root, "AGENTS.md"), "workspace rules");
    await write(path.join(worktree, "AGENTS.md"), "worktree rules");

    const files = projectContextFiles(sessionWorkspace(USER, worktree));

    expect(files.map((file) => file.content)).toEqual(["workspace rules", "worktree rules"]);
  });

  it("keeps one file per directory, the override winning", async () => {
    const repo = path.join(root, "projects/saale");
    await write(path.join(repo, "AGENTS.md"), "plain");
    await write(path.join(repo, "AGENTS.override.md"), "override");

    const files = projectContextFiles(sessionWorkspace(USER, repo));

    expect(files.map((file) => path.basename(file.path))).toEqual(["AGENTS.override.md"]);
    expect(files[0]?.content).toBe("override");
  });

  it("falls back to CLAUDE.md", async () => {
    const repo = path.join(root, "projects/saale");
    await write(path.join(repo, "CLAUDE.md"), "claude rules");

    const files = projectContextFiles(sessionWorkspace(USER, repo));

    expect(files.map((file) => path.basename(file.path))).toEqual(["CLAUDE.md"]);
  });

  it("stops at the workspace root, so the host's own AGENTS.md stays out", async () => {
    const worktree = path.join(root, "worktrees/saale/c-1");
    await write(path.join(volumeDir, "AGENTS.md"), "the operator's rules");
    await write(path.join(worktree, "AGENTS.md"), "the project's rules");

    const files = projectContextFiles(sessionWorkspace(USER, worktree));

    expect(files.map((file) => file.content)).toEqual(["the project's rules"]);
  });

  it("returns nothing for a workspace without instructions", () => {
    const files = projectContextFiles(sessionWorkspace(USER, path.join(root, "projects/saale")));

    expect(files).toEqual([]);
  });
});

describe("projectSkillPaths", () => {
  it("names the skills directory when the project has one", async () => {
    const worktree = path.join(root, "worktrees/saale/c-1");
    await write(
      path.join(worktree, ".pi/skills/release/SKILL.md"),
      ["---", "name: release", "description: Cut a release", "---", "", "Steps."].join("\n"),
    );

    const paths = await projectSkillPaths(sessionWorkspace(USER, worktree));

    expect(paths).toEqual([path.join(worktree, ".pi/skills")]);
  });

  it("names nothing when the project has no skills", async () => {
    const paths = await projectSkillPaths(sessionWorkspace(USER, path.join(root, "projects/x")));

    expect(paths).toEqual([]);
  });
});
