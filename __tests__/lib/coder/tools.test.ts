import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * The agent's way into a project's setup.
 *
 * A chat works in one checkout, so the env files every checkout inherits are
 * set on the project. These tools are how the agent fixes that mid-turn instead
 * of stopping to ask the user to open the panel.
 */

const mocks = vi.hoisted(() => ({
  findProject: vi.fn(),
  findChat: vi.fn(),
  updateProject: vi.fn(),
  findWorktrees: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    chatSession: { findFirst: mocks.findChat },
    coderProject: { findFirst: mocks.findProject, update: mocks.updateProject },
    coderWorktree: { findMany: mocks.findWorktrees },
  },
}));

vi.mock("@/lib/coder/git", () => ({
  GitError: class FakeGitError extends Error {},
  initRepo: vi.fn(),
  cloneRepo: vi.fn(),
  runGit: vi.fn(),
  runInWorkspace: vi.fn(),
  shellQuote: (value: string) => `'${value}'`,
}));

vi.mock("@/lib/coder/gitconfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/gitconfig")>()),
  ensureGitconfig: vi.fn(),
}));

import { createProjectSettingsTools } from "@/lib/coder/tools";
import { createSettingsTools } from "@/lib/settings/tools";

const USER = "user-1";
const SESSION = "chat-1";
const PROJECT_ID = "project-1";

let workspaceDir = "";
let originalWorkspacesDir: string | undefined;

function inWorkspace(relative: string): string {
  return path.join(workspaceDir, `user-${USER}`, relative);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    name: "Saale Web",
    slug: "saale-web",
    repoPath: "projects/saale-web",
    defaultBranch: "main",
    originUrl: null,
    envFiles: [{ path: ".env.local", content: "A=1\n" }],
    setupScript: "npm install",
    ...overrides,
  };
}

/** Run a tool and read the value its text result carries. */
async function run(tool: ToolDefinition, params: Record<string, unknown>) {
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
  const result = await execute("call-1", params);
  return JSON.parse(result.content[0]!.text) as {
    project: { id: string; name: string };
    envFiles: { path: string; content: string }[];
    setupScript: string | null;
  };
}

function tool(name: string, sessionId: string | undefined = SESSION): ToolDefinition {
  const found = createProjectSettingsTools(USER, sessionId).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(async () => {
  vi.clearAllMocks();
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-coder-tools-"));
  process.env.SANDBOX_WORKSPACES_DIR = workspaceDir;

  await fs.mkdir(inWorkspace("projects/saale-web/.git/info"), { recursive: true });
  await fs.writeFile(inWorkspace("projects/saale-web/.git/info/exclude"), "");

  mocks.findChat.mockResolvedValue({ projectId: PROJECT_ID });
  mocks.findProject.mockResolvedValue(row());
  mocks.findWorktrees.mockResolvedValue([]);
  mocks.updateProject.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(row(data)),
  );
});

afterEach(async () => {
  process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("project_settings_get", () => {
  it("reads the project of the chat it runs in", async () => {
    const value = await run(tool("project_settings_get"), {});

    expect(mocks.findChat).toHaveBeenCalledWith({
      where: { id: SESSION, userId: USER },
      select: { projectId: true },
    });
    expect(value.project).toMatchObject({ id: PROJECT_ID, name: "Saale Web" });
    expect(value.envFiles).toEqual([{ path: ".env.local", content: "A=1\n" }]);
    expect(value.setupScript).toBe("npm install");
  });

  it("finds a project by its slug", async () => {
    await run(tool("project_settings_get"), { project: "saale-web" });

    expect(mocks.findProject).toHaveBeenCalledWith({
      where: {
        userId: USER,
        OR: [{ id: "saale-web" }, { slug: "saale-web" }, { name: "saale-web" }],
      },
      select: { id: true, slug: true, name: true },
    });
  });

  it("says so when the chat has no project and none was named", async () => {
    mocks.findChat.mockResolvedValue({ projectId: null });

    await expect(run(tool("project_settings_get"), {})).rejects.toThrow(/not in a coder project/);
  });

  it("says so when no project matches", async () => {
    mocks.findProject.mockResolvedValue(null);

    await expect(run(tool("project_settings_get"), { project: "nope" })).rejects.toThrow(
      /No coder project matches/,
    );
  });
});

describe("project_settings_set", () => {
  it("saves the setup script and hands back what the project now holds", async () => {
    const value = await run(tool("project_settings_set"), { setupScript: "pnpm install" });

    expect(mocks.updateProject).toHaveBeenCalledWith({
      where: { id: PROJECT_ID },
      data: expect.objectContaining({ setupScript: "pnpm install" }),
      select: expect.any(Object),
    });
    expect(value.setupScript).toBe("pnpm install");
  });

  it("refuses a call that changes nothing", async () => {
    await expect(run(tool("project_settings_set"), {})).rejects.toThrow(/at least one/);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("surfaces the reason a refused path gives", async () => {
    await expect(
      run(tool("project_settings_set"), { envFiles: [{ path: "../.env", content: "" }] }),
    ).rejects.toThrow(/climb out of the checkout/);
  });

  it("writes the files it was given once, for the next checkouts", async () => {
    mocks.updateProject.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(row(data)),
    );

    const value = await run(tool("project_settings_set"), {
      envFiles: [{ path: ".env", content: "SHARED=1\n" }],
    });

    expect(value.envFiles).toEqual([{ path: ".env", content: "SHARED=1\n" }]);
    expect(await fs.readFile(inWorkspace("projects/saale-web/.git/info/exclude"), "utf8")).toBe(
      "/.env\n",
    );
  });
});

describe("where the tools live", () => {
  it("comes with the settings category", () => {
    const names = createSettingsTools(USER, SESSION).map((candidate) => candidate.name);

    expect(names).toContain("project_settings_get");
    expect(names).toContain("project_settings_set");
    expect(names).toContain("settings_list");
  });
});
