import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ removeContainer: vi.fn() }));

vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: () => !!process.env.SANDBOX_URL,
  removeContainer: hoisted.removeContainer,
}));

import { userIdentity } from "@/lib/sandbox/identity";
import { destroyUserSandbox } from "@/lib/sandbox/teardown";

const USER_ID = "clx9k2f4b0000abcd1234wxyz";
let workspacesRoot: string;

/** The directory a user's commands and files live in. */
const userDir = () => path.join(workspacesRoot, userIdentity(USER_ID));

beforeAll(async () => {
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-teardown-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspacesRoot);
  vi.stubEnv("SANDBOX_USER", "root");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_URL", "http://sandbox-exec:8100");
  vi.stubEnv("SANDBOX_API_KEY", "test-key");
  hoisted.removeContainer.mockResolvedValue(undefined);
  for (const entry of await fs.readdir(workspacesRoot)) {
    await fs.rm(path.join(workspacesRoot, entry), { recursive: true, force: true });
  }
});

describe("destroyUserSandbox", () => {
  it("removes the user's container and everything in their directory", async () => {
    const project = path.join(userDir(), "projects", "site");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "index.html"), "<h1>hi</h1>");

    await destroyUserSandbox(USER_ID);

    expect(hoisted.removeContainer).toHaveBeenCalledWith(userIdentity(USER_ID));
    await expect(fs.access(userDir())).rejects.toThrow();
  });

  it("removes the directory even when the service cannot remove the container", async () => {
    await fs.mkdir(userDir(), { recursive: true });
    hoisted.removeContainer.mockRejectedValue(new Error("ECONNREFUSED"));

    await destroyUserSandbox(USER_ID);

    await expect(fs.access(userDir())).rejects.toThrow();
  });

  it("leaves other users' workspaces alone", async () => {
    const otherId = "clx9k2f4b0000abcd9999other";
    const otherDir = path.join(workspacesRoot, userIdentity(otherId));
    await fs.mkdir(userDir(), { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "notes.md"), "still here");

    await destroyUserSandbox(USER_ID);

    expect(await fs.readFile(path.join(otherDir, "notes.md"), "utf8")).toBe("still here");
  });

  it("skips the container when no service is configured", async () => {
    vi.stubEnv("SANDBOX_URL", "");
    await fs.mkdir(userDir(), { recursive: true });

    await destroyUserSandbox(USER_ID);

    expect(hoisted.removeContainer).not.toHaveBeenCalled();
    await expect(fs.access(userDir())).rejects.toThrow();
  });
});
