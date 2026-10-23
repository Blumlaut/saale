import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ health: vi.fn(), removeContainer: vi.fn() }));

vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: () => !!process.env.SANDBOX_URL,
  health: hoisted.health,
  removeContainer: hoisted.removeContainer,
}));

import { sandboxIdentity } from "@/lib/council/accounts";
import { userIdentity } from "@/lib/sandbox/identity";
import { destroyCouncilSandbox, ensureCouncilSandbox } from "@/lib/council/sandbox";

let workspacesRoot: string;

beforeAll(async () => {
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-council-sandbox-"));
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
  hoisted.health.mockResolvedValue({ status: "ok" });
  hoisted.removeContainer.mockResolvedValue(undefined);
  for (const entry of await fs.readdir(workspacesRoot)) {
    await fs.rm(path.join(workspacesRoot, entry), { recursive: true, force: true });
  }
});

/** Resolved per test, so it follows the current SANDBOX_WORKSPACES_DIR. */
const identity = () => sandboxIdentity("3bd99582");

describe("ensureCouncilSandbox", () => {
  it("creates the council's directory and checks the service answers", async () => {
    await ensureCouncilSandbox(identity());

    expect((await fs.stat(identity().path)).isDirectory()).toBe(true);
    expect(hoisted.health).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a directory that exists is kept, not recreated", async () => {
    await ensureCouncilSandbox(identity());
    const file = path.join(identity().path, "brief.md");
    await fs.writeFile(file, "the council's work");

    await ensureCouncilSandbox(identity());

    expect(await fs.readFile(file, "utf8")).toBe("the council's work");
  });

  it("keeps the council's directory next to, not inside, the owner's", async () => {
    const userDir = path.join(workspacesRoot, userIdentity("user-1"));
    await fs.mkdir(userDir, { recursive: true });

    await ensureCouncilSandbox(identity());

    expect(path.dirname(identity().path)).toBe(workspacesRoot);
    expect(identity().path.startsWith(`${userDir}/`)).toBe(false);
  });

  it("fails before a run when the service does not answer", async () => {
    hoisted.health.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(ensureCouncilSandbox(identity())).rejects.toThrow(/ECONNREFUSED/);
  });

  it("refuses to start a council sandbox without the service", async () => {
    vi.stubEnv("SANDBOX_URL", "");

    await expect(ensureCouncilSandbox(identity())).rejects.toThrow(/SANDBOX_URL/);
    expect(hoisted.health).not.toHaveBeenCalled();
  });
});

describe("destroyCouncilSandbox", () => {
  it("removes the container and the directory", async () => {
    await ensureCouncilSandbox(identity());
    const file = path.join(identity().path, "member-notes.md");
    await fs.writeFile(file, "x");

    await destroyCouncilSandbox(identity());

    expect(hoisted.removeContainer).toHaveBeenCalledWith(identity().id);
    await expect(fs.access(identity().path)).rejects.toThrow();
  });

  it("removes the directory even when the container removal fails", async () => {
    await ensureCouncilSandbox(identity());
    hoisted.removeContainer.mockRejectedValue(new Error("No such container"));

    await destroyCouncilSandbox(identity());

    await expect(fs.access(identity().path)).rejects.toThrow();
  });

  it("does not touch another council's directory", async () => {
    const other = sandboxIdentity("aaaaaaaa");
    await ensureCouncilSandbox(identity());
    await ensureCouncilSandbox(other);
    await fs.writeFile(path.join(other.path, "keep.md"), "other council");

    await destroyCouncilSandbox(identity());

    expect(await fs.readFile(path.join(other.path, "keep.md"), "utf8")).toBe("other council");
  });

  it("skips the container when there is no service to ask", async () => {
    const second = sandboxIdentity("bbbbbbbb");
    await fs.mkdir(second.path, { recursive: true });
    vi.stubEnv("SANDBOX_URL", "");

    await destroyCouncilSandbox(second);

    expect(hoisted.removeContainer).not.toHaveBeenCalled();
    await expect(fs.access(second.path)).rejects.toThrow();
  });

  it("never throws: a council that is gone must not stay on the delete response", async () => {
    // Nothing on disk, no service: both halves are no-ops rather than failures.
    await expect(destroyCouncilSandbox(identity())).resolves.toBeUndefined();
  });
});
