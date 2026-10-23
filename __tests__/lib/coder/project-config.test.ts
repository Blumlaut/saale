import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a project hands to each of its worktrees.
 *
 * The rules that matter: a path can never leave the checkout, a file that is
 * already there is not overwritten, and a checkout with env files in it still
 * looks clean to git.
 */

const mocks = vi.hoisted(() => ({ runInWorkspace: vi.fn() }));

vi.mock("@/lib/coder/git", () => ({
  runInWorkspace: mocks.runInWorkspace,
  shellQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}));

import { CoderProjectError } from "@/lib/coder/project-error";
import {
  MAX_ENV_FILES,
  excludeEnvFiles,
  parseEnvFiles,
  parseSetupScript,
  runSetupScript,
  storedEnvFiles,
  writeEnvFiles,
} from "@/lib/coder/project-config";

const USER = "user-1";
const WORKTREE = "worktrees/saale/c-1a2b3c4d";
const REPO = "projects/saale";

let workspaceDir = "";
let originalWorkspacesDir: string | undefined;

function inWorkspace(relative: string): string {
  return path.join(workspaceDir, `user-${USER}`, relative);
}

beforeEach(async () => {
  vi.clearAllMocks();
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-project-config-"));
  process.env.SANDBOX_WORKSPACES_DIR = workspaceDir;
  await fs.mkdir(inWorkspace(WORKTREE), { recursive: true });
  await fs.mkdir(inWorkspace(`${REPO}/.git/info`), { recursive: true });
  await fs.writeFile(inWorkspace(`${REPO}/.git/info/exclude`), "# git's own excludes\n");
});

afterEach(async () => {
  process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("parseEnvFiles", () => {
  it("takes nested paths and sorts them", () => {
    const files = parseEnvFiles([
      { path: "apps/web/.env.local", content: "B=2" },
      { path: ".env", content: "A=1" },
    ]);

    expect(files).toEqual([
      { path: ".env", content: "A=1" },
      { path: "apps/web/.env.local", content: "B=2" },
    ]);
  });

  it("treats an absent value as no files", () => {
    expect(parseEnvFiles(undefined)).toEqual([]);
    expect(parseEnvFiles(null)).toEqual([]);
  });

  it("refuses a path that climbs out of the checkout", () => {
    expect(() => parseEnvFiles([{ path: "../other/.env", content: "" }])).toThrow(
      CoderProjectError,
    );
    expect(() => parseEnvFiles([{ path: "apps/../../.env", content: "" }])).toThrow(/climb/);
  });

  it("refuses absolute paths, git metadata and repeated names", () => {
    expect(() => parseEnvFiles([{ path: "/etc/env", content: "" }])).toThrow(/relative/);
    expect(() => parseEnvFiles([{ path: ".git/config", content: "" }])).toThrow(/\.git/);
    expect(() =>
      parseEnvFiles([
        { path: ".env", content: "A=1" },
        { path: ".env", content: "A=2" },
      ]),
    ).toThrow(/twice/);
    expect(() => parseEnvFiles([{ path: "envs/", content: "" }])).toThrow(/file/);
  });

  it("refuses more files than a project may have", () => {
    const tooMany = Array.from({ length: MAX_ENV_FILES + 1 }, (_, index) => ({
      path: `.env.${index}`,
      content: "",
    }));
    expect(() => parseEnvFiles(tooMany)).toThrow(/at most/);
  });
});

describe("storedEnvFiles", () => {
  it("keeps reading when the column holds something else entirely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(storedEnvFiles({ nope: true })).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("parseSetupScript", () => {
  it("keeps the script's newlines and drops the padding", () => {
    expect(parseSetupScript("\n  npm install\n  npm test  \n")).toBe("npm install\n  npm test");
  });

  it("has nothing to run for an empty script", () => {
    expect(parseSetupScript("   \n\t ")).toBeNull();
    expect(parseSetupScript(undefined)).toBeNull();
  });
});

describe("writeEnvFiles", () => {
  const files = [
    { path: ".env.local", content: "DATABASE_URL=postgres://localhost\n" },
    { path: "apps/web/.env", content: "API=1\n" },
  ];

  it("writes every file, creating the directories", async () => {
    const written = await writeEnvFiles(USER, WORKTREE, files);

    expect(written).toEqual([".env.local", "apps/web/.env"]);
    expect(await fs.readFile(inWorkspace(`${WORKTREE}/.env.local`), "utf8")).toBe(
      "DATABASE_URL=postgres://localhost\n",
    );
    expect(await fs.readFile(inWorkspace(`${WORKTREE}/apps/web/.env`), "utf8")).toBe("API=1\n");
  });

  it("leaves a file that is already there alone when asked to", async () => {
    await fs.writeFile(inWorkspace(`${WORKTREE}/.env.local`), "EDITED=by-the-agent\n");

    const written = await writeEnvFiles(USER, WORKTREE, files, { onlyMissing: true });

    expect(written).toEqual(["apps/web/.env"]);
    expect(await fs.readFile(inWorkspace(`${WORKTREE}/.env.local`), "utf8")).toBe(
      "EDITED=by-the-agent\n",
    );
    expect(await fs.readFile(inWorkspace(`${WORKTREE}/apps/web/.env`), "utf8")).toBe("API=1\n");
  });
});

describe("excludeEnvFiles", () => {
  const files = [
    { path: ".env", content: "" },
    { path: "apps/web/.env.local", content: "" },
  ];

  it("lists each path once, keeping what was already excluded", async () => {
    await fs.appendFile(inWorkspace(`${REPO}/.git/info/exclude`), "*.log");

    await excludeEnvFiles(USER, REPO, files);
    await excludeEnvFiles(USER, REPO, files);

    const body = await fs.readFile(inWorkspace(`${REPO}/.git/info/exclude`), "utf8");
    expect(body).toBe("# git's own excludes\n*.log\n/.env\n/apps/web/.env.local\n");
  });
});

describe("runSetupScript", () => {
  it("runs the script in the checkout with a login shell", async () => {
    mocks.runInWorkspace.mockResolvedValue({ stdout: "installed", stderr: "", exitCode: 0 });

    expect(await runSetupScript(USER, WORKTREE, "npm install")).toBe(true);
    expect(mocks.runInWorkspace).toHaveBeenCalledWith(USER, {
      cwd: WORKTREE,
      command: "bash -lc 'npm install'",
      timeoutSeconds: expect.any(Number),
    });
  });

  it("reports a failed script without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runInWorkspace.mockResolvedValue({
      stdout: "",
      stderr: "npm ERR! could not resolve",
      exitCode: 1,
    });

    expect(await runSetupScript(USER, WORKTREE, "npm install")).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("exited 1"));
    error.mockRestore();
  });

  it("runs nothing when there is no script", async () => {
    expect(await runSetupScript(USER, WORKTREE, null)).toBe(true);
    expect(mocks.runInWorkspace).not.toHaveBeenCalled();
  });
});
