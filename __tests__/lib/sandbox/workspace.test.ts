import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureWorkspace,
  ensureWorkspaceDirectory,
  identityPath,
  removeWorkspace,
  userWorkspacePath,
  workspaceOwner,
  writeOwned,
  writeWorkspaceFile,
} from "@/lib/sandbox/workspace";
import { InvalidSandboxIdentityError, userIdentity } from "@/lib/sandbox/identity";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspaces-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", root);
  vi.stubEnv("SANDBOX_USER", "root");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const entry of await fs.readdir(root)) {
    await fs.rm(path.join(root, entry), { recursive: true, force: true });
  }
});

describe("identityPath", () => {
  it("gives each identity its own directory under the volume", () => {
    expect(identityPath("user-abc")).toBe(path.join(root, "user-abc"));
    expect(identityPath("council-abcd")).toBe(path.join(root, "council-abcd"));
    expect(userWorkspacePath("abc")).toBe(path.join(root, userIdentity("abc")));
  });

  it("refuses a string that is not an identity", () => {
    expect(() => identityPath("../../etc")).toThrow(InvalidSandboxIdentityError);
    expect(() => userWorkspacePath("")).toThrow(InvalidSandboxIdentityError);
  });
});

describe("ensureWorkspace", () => {
  it("creates the directory and keeps what is already in it", async () => {
    const dir = await ensureWorkspace("user-abc");
    await fs.writeFile(path.join(dir, "notes.md"), "keep me");

    await ensureWorkspace("user-abc");

    expect(await fs.readFile(path.join(dir, "notes.md"), "utf8")).toBe("keep me");
  });

  it("creates the directory 0770 and nothing wider", async () => {
    const dir = await ensureWorkspace("user-abc");
    const stats = await fs.stat(dir);
    expect(stats.mode & 0o777).toBe(0o770);
  });

  it("keeps 0770 whatever umask the deployment runs under", async () => {
    const previous = process.umask(0o077);
    try {
      const dir = await ensureWorkspace("user-umask");

      expect((await fs.stat(dir)).mode & 0o777).toBe(0o770);
    } finally {
      process.umask(previous);
    }
  });

  it("keeps one identity out of another's path", () => {
    expect(identityPath("user-a").startsWith(`${identityPath("user-b")}/`)).toBe(false);
  });
});

describe("removeWorkspace", () => {
  it("removes the directory and everything in it", async () => {
    const dir = await ensureWorkspace("council-abcd");
    await fs.mkdir(path.join(dir, "deep", "er"), { recursive: true });
    await fs.writeFile(path.join(dir, "deep", "er", "f.txt"), "x");

    await removeWorkspace("council-abcd");

    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("is a no-op for a directory that is already gone", async () => {
    await expect(removeWorkspace("council-never-created")).resolves.toBeUndefined();
  });
});

describe("writeWorkspaceFile", () => {
  it("creates the parents and writes inside the user's directory", async () => {
    const absolute = await writeWorkspaceFile("abc", "uploads/report.pdf", Buffer.from("pdf"));

    expect(absolute).toBe(path.join(root, userIdentity("abc"), "uploads", "report.pdf"));
    expect(await fs.readFile(absolute, "utf8")).toBe("pdf");
  });

  it("refuses a relative path that would climb out of the workspace", async () => {
    await expect(
      writeWorkspaceFile("abc", "../../user-other/secret.txt", Buffer.from("x")),
    ).rejects.toThrow(/outside the workspace/);
  });
});

describe("ensureWorkspaceDirectory", () => {
  it("creates the directory and its parents inside the workspace", async () => {
    const absolute = await ensureWorkspaceDirectory("abc", "projects/saale-web", 0o770);

    expect(absolute).toBe(path.join(root, userIdentity("abc"), "projects", "saale-web"));
    expect((await fs.stat(absolute)).isDirectory()).toBe(true);
    expect((await fs.stat(absolute)).mode & 0o777).toBe(0o770);
  });

  it("keeps what is already in the directory", async () => {
    const absolute = await ensureWorkspaceDirectory("abc", "projects/saale-web");
    await fs.writeFile(path.join(absolute, "README.md"), "keep me");

    await ensureWorkspaceDirectory("abc", "projects/saale-web");

    expect(await fs.readFile(path.join(absolute, "README.md"), "utf8")).toBe("keep me");
  });

  it("refuses a relative path that would climb out of the workspace", async () => {
    await expect(ensureWorkspaceDirectory("abc", "../../etc")).rejects.toThrow(
      /outside the workspace/,
    );
  });
});

describe("ownership", () => {
  it("applies no owner while commands run as root", () => {
    expect(workspaceOwner()).toBeNull();
  });

  it("reports the configured account when commands run as agent", () => {
    vi.stubEnv("SANDBOX_USER", "agent");
    vi.stubEnv("SANDBOX_UID", "2000");
    vi.stubEnv("SANDBOX_GID", "2001");

    expect(workspaceOwner()).toEqual({ uid: 2000, gid: 2001 });
    vi.unstubAllEnvs();
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", root);
    vi.stubEnv("SANDBOX_USER", "root");
  });

  it("writes a file into a directory that does not exist yet", async () => {
    const target = path.join(root, "user-abc", "new", "dir", "file.txt");

    await writeOwned(target, Buffer.from("hi"));

    expect(await fs.readFile(target, "utf8")).toBe("hi");
  });

  it("hands every directory it creates to the configured account", async () => {
    vi.stubEnv("SANDBOX_USER", "agent");
    vi.stubEnv("SANDBOX_UID", String(process.getuid?.() ?? 0));
    vi.stubEnv("SANDBOX_GID", String(process.getgid?.() ?? 0));

    const target = path.join(root, "user-abc", "a", "b", "c.txt");
    await writeOwned(target, Buffer.from("x"));

    // A root-owned intermediate directory would stop the container's account
    // from writing inside it, whatever the file's own owner says.
    for (const dir of ["user-abc", path.join("user-abc", "a"), path.join("user-abc", "a", "b")]) {
      const stats = await fs.stat(path.join(root, dir));
      expect(stats.uid).toBe(process.getuid?.());
    }

    vi.unstubAllEnvs();
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", root);
    vi.stubEnv("SANDBOX_USER", "root");
  });
});
