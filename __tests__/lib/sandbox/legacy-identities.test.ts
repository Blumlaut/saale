import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveUserWorkspaceKey } from "@/lib/sandbox/identity";
import {
  legacyTargetName,
  migrateLegacyIdentities,
  migrateWorkspaceIdentitiesOnBoot,
  repairWorkspacePaths,
  rewriteWorkspacePaths,
} from "@/lib/sandbox/legacy-identities";

/**
 * The rename a deploy must not need an operator for.
 *
 * Two properties matter and both are tested here: the app finds the same
 * directory after the migration as before it, and running it from several
 * processes at once (web, worker, sandbox service) cannot split a user's files.
 */

/** What a user id looked like before the keys: 32 alphanumeric characters. */
const LEGACY_ID = "yy7vfya8Gg33Y5ROHdK2WhRRKvGqs5NA";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-legacy-identities-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

async function entryNames(): Promise<string[]> {
  return (await fs.readdir(root)).sort();
}

describe("legacyTargetName", () => {
  it("names a legacy directory by the key the app now derives", () => {
    expect(legacyTargetName(`user-${LEGACY_ID}`)).toBe(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`);
  });

  it("has nothing to do for a directory that already carries a key", () => {
    expect(legacyTargetName(`user-${deriveUserWorkspaceKey(LEGACY_ID)}`)).toBeNull();
  });

  it("has nothing to do for anything that is not a user's directory", () => {
    expect(legacyTargetName("council-3bd99582")).toBeNull();
    expect(legacyTargetName("lost+found")).toBeNull();
    expect(legacyTargetName(`user-${LEGACY_ID}/x`)).toBeNull();
  });

  it("refuses to guess at a suffix that is not a user id", () => {
    expect(legacyTargetName("user-short")).toBeNull();
  });
});

describe("migrateLegacyIdentities", () => {
  it("moves the legacy directory and keeps what is in it", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });
    await seed("council-3bd99582", { "brief.md": "council work" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(await entryNames()).toEqual([
      "council-3bd99582",
      `user-${deriveUserWorkspaceKey(LEGACY_ID)}`,
    ]);
    const moved = path.join(root, `user-${deriveUserWorkspaceKey(LEGACY_ID)}`, "notes.md");
    expect(await fs.readFile(moved, "utf8")).toBe("keep me");
  });

  it("is idempotent: a second boot finds nothing to do", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    await migrateLegacyIdentities();
    const second = await migrateLegacyIdentities();

    expect(second).toEqual({ renamed: [], conflicts: [], unrecognised: [] });
    expect(await entryNames()).toEqual([`user-${deriveUserWorkspaceKey(LEGACY_ID)}`]);
  });

  it("survives three processes doing it at once", async () => {
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    const reports = await Promise.all([
      migrateLegacyIdentities(),
      migrateLegacyIdentities(),
      migrateLegacyIdentities(),
    ]);

    expect(reports.flatMap((report) => report.renamed)).toEqual([
      { from: `user-${LEGACY_ID}`, to: `user-${deriveUserWorkspaceKey(LEGACY_ID)}` },
    ]);
    expect(reports.flatMap((report) => report.conflicts)).toEqual([]);
    const moved = path.join(root, `user-${deriveUserWorkspaceKey(LEGACY_ID)}`, "notes.md");
    expect(await fs.readFile(moved, "utf8")).toBe("keep me");
  });

  it("leaves the worktrees of an existing chat usable", async () => {
    await seedGitWorkspace(`user-${LEGACY_ID}`);

    await migrateLegacyIdentities();

    const workspace = path.join(root, KEYED);
    const worktreeGit = path.join(workspace, "worktrees", "saale", "c-1a2b3c4d", ".git");
    expect(await fs.readFile(worktreeGit, "utf8")).toBe(
      `gitdir: ${workspace}/projects/saale/.git/worktrees/c-1a2b3c4d\n`,
    );
    expect(await fs.readFile(path.join(workspace, ".gitconfig"), "utf8")).toContain(
      `directory = ${workspace}`,
    );
  });

  it("repairs a workspace an earlier boot renamed but did not finish", async () => {
    // The deployment this landed on renamed the directories first and repaired
    // second; a boot that stopped in between leaves exactly this.
    const stale = await seedGitWorkspace(`user-${LEGACY_ID}`);
    const keyed = path.join(root, KEYED);
    await fs.rename(stale, keyed);

    await migrateLegacyIdentities();

    expect(await fs.readFile(path.join(keyed, ".gitconfig"), "utf8")).toContain(
      `directory = ${keyed}`,
    );
  });

  it("refuses to merge two directories into one", async () => {
    const keyed = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    await seed(`user-${LEGACY_ID}`, { "old.md": "old" });
    await seed(keyed, { "new.md": "new" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([]);
    expect(report.conflicts).toEqual([{ from: `user-${LEGACY_ID}`, to: keyed }]);
    expect(await fs.readFile(path.join(root, `user-${LEGACY_ID}`, "old.md"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(root, keyed, "new.md"), "utf8")).toBe("new");
  });

  it("reports a user directory it cannot name, rather than moving it", async () => {
    await seed("user-short", { "notes.md": "unknown" });

    const report = await migrateLegacyIdentities();

    expect(report.renamed).toEqual([]);
    expect(report.unrecognised).toEqual(["user-short"]);
    expect(await entryNames()).toEqual(["user-short"]);
  });

  it("does nothing when the volume is not mounted yet", async () => {
    await fs.rm(root, { recursive: true, force: true });

    expect(await migrateLegacyIdentities()).toEqual({
      renamed: [],
      conflicts: [],
      unrecognised: [],
    });
  });
});

/** A workspace with the absolute paths git and the app write into one. */
async function seedGitWorkspace(name: string, project = "saale", chat = "c-1a2b3c4d") {
  const workspace = path.join(root, name);
  const gitDir = path.join(workspace, "projects", project, ".git", "worktrees", chat);
  const worktree = path.join(workspace, "worktrees", project, chat);
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(gitDir, "gitdir"), `${worktree}/.git\n`);
  await fs.writeFile(
    path.join(worktree, ".git"),
    `gitdir: ${workspace}/projects/${project}/.git/worktrees/${chat}\n`,
  );
  await fs.writeFile(path.join(workspace, ".gitconfig"), `[safe]\n\tdirectory = ${workspace}\n`);
  return workspace;
}

const KEYED = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;

describe("rewriteWorkspacePaths", () => {
  it("points a path at the directory the workspace has now", () => {
    const before = `gitdir: /workspaces/user-${LEGACY_ID}/projects/saale/.git/worktrees/c-1`;

    expect(rewriteWorkspacePaths(before, KEYED, `/w/${KEYED}`)).toBe(
      `gitdir: /w/${KEYED}/projects/saale/.git/worktrees/c-1`,
    );
  });

  it("leaves a path that is already right alone", () => {
    const line = `gitdir: /w/${KEYED}/worktrees/saale/c-1/.git`;

    expect(rewriteWorkspacePaths(line, KEYED, `/w/${KEYED}`)).toBe(line);
  });

  it("leaves another user's workspace alone", () => {
    const other = `user-${deriveUserWorkspaceKey("someone-else-entirely")}`;
    const line = `directory = /w/${other}`;

    expect(rewriteWorkspacePaths(line, KEYED, `/w/${KEYED}`)).toBe(line);
  });
});

/** Git with no user or system config reaching into the fixture. */
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Saale", "-c", "user.email=saale@example.com", ...args],
    {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
  return stdout;
}

describe("repairWorkspacePaths", () => {
  it("follows a rename through git's worktree links and the gitconfig", async () => {
    const identity = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    const legacy = await seedGitWorkspace(`user-${LEGACY_ID}`);
    await fs.rename(legacy, path.join(root, identity));

    const rewritten = await repairWorkspacePaths(identity, path.join(root, identity));

    const worktreeGit = path.join(root, identity, "worktrees", "saale", "c-1a2b3c4d", ".git");
    const gitdir = path.join(
      root,
      identity,
      "projects",
      "saale",
      ".git",
      "worktrees",
      "c-1a2b3c4d",
      "gitdir",
    );
    expect(rewritten.sort()).toEqual(
      [worktreeGit, gitdir, path.join(root, identity, ".gitconfig")].sort(),
    );
    expect(await fs.readFile(worktreeGit, "utf8")).toBe(
      `gitdir: ${path.join(root, identity)}/projects/saale/.git/worktrees/c-1a2b3c4d\n`,
    );
    expect(await fs.readFile(gitdir, "utf8")).toBe(
      `${path.join(root, identity)}/worktrees/saale/c-1a2b3c4d/.git\n`,
    );
    expect(await fs.readFile(path.join(root, identity, ".gitconfig"), "utf8")).toContain(
      `directory = ${path.join(root, identity)}`,
    );
  });

  it("makes a checkout that was moved with its workspace usable again", async () => {
    // The real thing: a repository, a chat's worktree beside it, and then the
    // whole workspace directory renamed underneath both.
    const legacyName = `user-${LEGACY_ID}`;
    const identity = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    const legacy = path.join(root, legacyName);
    const repo = path.join(legacy, "projects", "saale");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, "init", "--initial-branch=main");
    await fs.writeFile(path.join(repo, "README.md"), "hi\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "first");
    await git(
      repo,
      "worktree",
      "add",
      "-b",
      "wt/c-1",
      path.join(legacy, "worktrees", "saale", "c-1"),
    );

    const moved = path.join(root, identity);
    await fs.rename(legacy, moved);
    const checkout = path.join(moved, "worktrees", "saale", "c-1");

    await expect(git(checkout, "status", "--porcelain")).rejects.toThrow(/not a git repository/);

    await repairWorkspacePaths(identity, moved);

    expect(await git(checkout, "status", "--porcelain")).toBe("");
    const movedRepo = path.join(moved, "projects", "saale");
    expect(await git(movedRepo, "worktree", "list", "--porcelain")).toContain(checkout);
  });

  it("is a no-op the second time", async () => {
    const identity = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    const legacy = await seedGitWorkspace(`user-${LEGACY_ID}`);
    await fs.rename(legacy, path.join(root, identity));
    await repairWorkspacePaths(identity, path.join(root, identity));

    expect(await repairWorkspacePaths(identity, path.join(root, identity))).toEqual([]);
  });

  it("does not follow one user's links into another's workspace", async () => {
    const mine = `user-${deriveUserWorkspaceKey(LEGACY_ID)}`;
    const theirs = `user-${deriveUserWorkspaceKey("someone-else-entirely")}`;
    const workspace = path.join(root, mine);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, ".gitconfig"), `directory = /w/${theirs}\n`);

    expect(await repairWorkspacePaths(mine, workspace)).toEqual([]);
    expect(await fs.readFile(path.join(workspace, ".gitconfig"), "utf8")).toBe(
      `directory = /w/${theirs}\n`,
    );
  });
});

describe("migrateWorkspaceIdentitiesOnBoot", () => {
  it("moves the directories and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seed(`user-${LEGACY_ID}`, { "notes.md": "keep me" });

    await migrateWorkspaceIdentitiesOnBoot("web");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[web] moved 1 workspace directory"));
    warn.mockRestore();
  });

  it("keeps a startup going when the volume cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.writeFile(root, "not a directory");

    await expect(migrateWorkspaceIdentitiesOnBoot("worker")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("[worker] workspace identity migration failed"),
      expect.anything(),
    );
    error.mockRestore();
  });
});
