import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError, FilePathEscapeError } from "@/lib/files/errors";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { loadChatCheckout } from "@/lib/coder/checkout";
import { userIdentity } from "@/lib/sandbox/identity";

vi.mock("@/lib/coder/checkout", () => ({
  loadChatCheckout: vi.fn(),
}));

const userId = "user-1";

let workspacesRoot: string;
let userRoot: string;

beforeAll(async () => {
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspace-file-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspacesRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  userRoot = path.join(workspacesRoot, userIdentity(userId));
  await fs.mkdir(userRoot, { recursive: true });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.mocked(loadChatCheckout).mockReset();
  vi.mocked(loadChatCheckout).mockResolvedValue(null);
  await fs.rm(userRoot, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });
});

/** The checkout a coder chat works in, or none. */
function chatCheckout(checkoutPath: string | null) {
  if (!checkoutPath) return null;
  return { path: checkoutPath, branch: "main", baseSha: "abc1234", mode: "worktree" as const };
}

/** Write a file into the user's workspace and return its relative path. */
async function writeWorkspaceFile(name: string, content: Buffer | string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(userRoot, name)), { recursive: true });
  await fs.writeFile(path.join(userRoot, name), content);
  return name;
}

describe("readWorkspaceFile", () => {
  it("reads a file with its name, size and type", async () => {
    const relative = await writeWorkspaceFile("reports/q3.pdf", Buffer.from("pdf-bytes"));

    const file = await readWorkspaceFile(userId, relative);

    expect(file).toMatchObject({ fileName: "q3.pdf", size: 9, mimeType: "application/pdf" });
    expect(Buffer.from(file.buffer).toString()).toBe("pdf-bytes");
  });

  it("hands back any file type as-is, extension unknown or not", async () => {
    const relative = await writeWorkspaceFile("model.gguf", Buffer.from([0x00, 0x01, 0xff]));

    const file = await readWorkspaceFile(userId, relative);

    expect(file.mimeType).toBe("application/octet-stream");
    expect(file.size).toBe(3);
  });

  it("refuses a path that climbs out of the workspace", async () => {
    await writeWorkspaceFile("notes.md", "hello");

    await expect(readWorkspaceFile(userId, "../user-2/secret.txt")).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });

  it("reports a missing file rather than an empty one", async () => {
    await expect(readWorkspaceFile(userId, "nope.pdf")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("reports a directory as such", async () => {
    await fs.mkdir(path.join(userRoot, "reports"), { recursive: true });

    await expect(readWorkspaceFile(userId, "reports")).rejects.toThrow("Not a file: reports");
  });

  it("refuses a file over the ceiling without reading it", async () => {
    const relative = await writeWorkspaceFile("huge.bin", Buffer.alloc(1024));

    await expect(readWorkspaceFile(userId, relative, { maxBytes: 512 })).rejects.toThrow(
      /^File too large: 0\.0MB\. Max: 0MB\.$/,
    );
  });

  it("reads a file exactly at the shared ceiling", async () => {
    const relative = await writeWorkspaceFile("backup.tar", Buffer.from("data"));

    await expect(readWorkspaceFile(userId, relative, { maxBytes: 4 })).resolves.toMatchObject({
      size: 4,
    });
  });

  it("does not resolve a name into another identity's directory", async () => {
    const other = path.join(workspacesRoot, "user-2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");

    await expect(readWorkspaceFile(userId, "secret.txt")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(readWorkspaceFile(userId, "../user-2/secret.txt")).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });

  it("refuses a symlink that points into another identity's directory", async () => {
    const other = path.join(workspacesRoot, "user-2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");
    await fs.symlink(path.join(other, "secret.txt"), path.join(userRoot, "link.txt"));

    await expect(readWorkspaceFile(userId, "link.txt")).rejects.toBeInstanceOf(FilePathEscapeError);
  });
});

describe("readWorkspaceFile for a coder chat", () => {
  // Computed lazily: `userRoot` only exists once the beforeAll has run.
  const worktree = () => path.join(userRoot, "worktrees", "proj", "chat-1");
  // What `CoderWorktree.path` holds: relative to the workspace root.
  const storedWorktree = "worktrees/proj/chat-1";

  beforeEach(async () => {
    await fs.mkdir(worktree(), { recursive: true });
  });

  it("resolves a relative path against the chat's active worktree", async () => {
    await fs.writeFile(path.join(worktree(), "notes.md"), "worktree notes");
    await fs.writeFile(path.join(userRoot, "notes.md"), "root notes");
    vi.mocked(loadChatCheckout).mockResolvedValue(chatCheckout(storedWorktree));

    const file = await readWorkspaceFile(userId, "notes.md", { session: "chat-1" });

    expect(Buffer.from(file.buffer).toString()).toBe("worktree notes");
  });

  it("falls back to the workspace root when the worktree has no such file", async () => {
    await fs.writeFile(path.join(userRoot, "notes.md"), "root notes");
    vi.mocked(loadChatCheckout).mockResolvedValue(chatCheckout(storedWorktree));

    const file = await readWorkspaceFile(userId, "notes.md", { session: "chat-1" });

    expect(Buffer.from(file.buffer).toString()).toBe("root notes");
  });

  it("resolves against the root when the chat has no worktree", async () => {
    await fs.writeFile(path.join(userRoot, "notes.md"), "root notes");
    vi.mocked(loadChatCheckout).mockResolvedValue(chatCheckout(null));

    const file = await readWorkspaceFile(userId, "notes.md", { session: "chat-1" });

    expect(Buffer.from(file.buffer).toString()).toBe("root notes");
  });

  it("never reads a worktree stored outside the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "saale-outside-"));
    await fs.writeFile(path.join(outside, "leak.txt"), "top secret");
    vi.mocked(loadChatCheckout).mockResolvedValue(chatCheckout(outside));

    await expect(
      readWorkspaceFile(userId, "leak.txt", { session: "chat-1" }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("refuses a traversal that would climb out of the workspace", async () => {
    vi.mocked(loadChatCheckout).mockResolvedValue(chatCheckout(storedWorktree));

    await expect(
      readWorkspaceFile(userId, "../../user-2/secret.txt", { session: "chat-1" }),
    ).rejects.toBeInstanceOf(FilePathEscapeError);
  });
});
