import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { MAX_SHARED_FILE_BYTES } from "@/lib/files/workspace-file";
import { userWorkspacePath } from "@/lib/sandbox/workspace";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireSession } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: mockRequireSession,
}));

const { mockLoadChatCheckout } = vi.hoisted(() => ({
  mockLoadChatCheckout: vi.fn(),
}));

vi.mock("@/lib/coder/checkout", () => ({
  loadChatCheckout: mockLoadChatCheckout,
}));

let GET: typeof import("@/app/api/chat/workspace-files/route").GET;

const USER_ID = "user-1";
let tmpRoot: string;
/** The user's workspace directory inside the stubbed volume. */
let userRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspace-files-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", tmpRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  userRoot = userWorkspacePath(USER_ID);
  vi.resetModules();
  GET = (await import("@/app/api/chat/workspace-files/route")).GET;
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
  mockLoadChatCheckout.mockResolvedValue(null);
  await fs.rm(userRoot, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function request(file: string, ifNoneMatch?: string) {
  const req = new NextRequest(
    `http://localhost/api/chat/workspace-files?file=${encodeURIComponent(file)}`,
    { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} },
  );
  return GET(req);
}

function downloadRequest(file: string) {
  return GET(
    new NextRequest(
      `http://localhost/api/chat/workspace-files?file=${encodeURIComponent(file)}&download=1`,
    ),
  );
}

function sessionRequest(file: string, sessionId: string) {
  return GET(
    new NextRequest(
      `http://localhost/api/chat/workspace-files?file=${encodeURIComponent(file)}&session=${sessionId}`,
    ),
  );
}

/** The checkout a coder chat works in. */
function chatCheckout(checkoutPath: string) {
  return { path: checkoutPath, branch: "main", baseSha: "abc1234", mode: "worktree" as const };
}

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// ─── Mutable file at a stable URL ────────────────────────────────────────────

describe("workspace file serving", () => {
  /**
   * The whole point: `report.pdf` keeps its path while an agent rewrites it, so
   * the download URL never changes. A long-lived `max-age` made the browser
   * replay the first (pre-edit) bytes forever  the file had to be renamed to
   * be downloadable in its updated state.
   */
  it("serves the updated bytes from an unchanged URL, and 304s on unchanged content", async () => {
    const dir = userRoot;
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "report.pdf");

    const original = Buffer.from("%PDF-1.4 original body");
    await fs.writeFile(file, original);

    const first = await request("report.pdf");
    expect(first.status).toBe(200);
    expect((await body(first)).equals(original)).toBe(true);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");

    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);

    // Unchanged file + the validator the client was given → no bytes on the wire.
    const revalidated = await request("report.pdf", etag!);
    expect(revalidated.status).toBe(304);
    expect((await body(revalidated)).length).toBe(0);

    // Agent rewrites the file under the same name: the stale validator must not
    // resurrect the old bytes.
    const updated = Buffer.from("%PDF-1.4 edited body, now longer");
    await fs.writeFile(file, updated);

    const second = await request("report.pdf", etag!);
    expect(second.status).toBe(200);
    expect((await body(second)).equals(updated)).toBe(true);
    expect(second.headers.get("etag")).not.toBe(etag);
  });

  it("accepts a weak validator from the client", async () => {
    const dir = userRoot;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "hello");

    const first = await request("notes.txt");
    const etag = first.headers.get("etag")!;

    expect((await request("notes.txt", `W/${etag}`)).status).toBe(304);
    expect((await request("notes.txt", `"other", ${etag}`)).status).toBe(304);
    expect((await request("notes.txt", '"unrelated"')).status).toBe(200);
  });

  it("stays fresh when an agent rewrites a file the chat already fetched", async () => {
    const dir = path.join(userRoot, "uploads");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "report.pdf");

    const original = Buffer.from("%PDF-1.4 workspace original");
    await fs.writeFile(file, original);

    const first = await request("uploads/report.pdf");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/pdf");
    expect((await body(first)).equals(original)).toBe(true);
    const etag = first.headers.get("etag")!;

    const edited = Buffer.from("%PDF-1.4 workspace edited");
    await fs.writeFile(file, edited);

    const second = await request("uploads/report.pdf", etag);
    expect(second.status).toBe(200);
    expect((await body(second)).equals(edited)).toBe(true);
  });

  it("refuses a symlink that points at another user's file", async () => {
    const other = userWorkspacePath("user-2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");
    await fs.symlink(path.join(other, "secret.txt"), path.join(userRoot, "link.txt"));

    const res = await request("link.txt");
    expect(res.status).toBe(403);
  });

  it("rejects paths that escape the workspace", async () => {
    const res = await request("../../etc/passwd");
    expect(res.status).toBe(403);
  });

  it("404s a missing file", async () => {
    expect((await request("nope.pdf")).status).toBe(404);
  });

  it("marks a requested download as an attachment, keeping the name", async () => {
    const dir = path.join(userRoot, "reports");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "q3.pdf"), "%PDF-1.4");

    // Preview stays inline  only `download=1` turns the response into a file
    // the browser's download manager (and an installed PWA) will save.
    expect((await request("reports/q3.pdf")).headers.get("content-disposition")).toBeNull();

    const res = await downloadRequest("reports/q3.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="q3.pdf"; filename*=UTF-8''q3.pdf`,
    );
  });

  it("streams a download past the ceiling the chat channels have to respect", async () => {
    // Inline and Telegram delivery are capped by what a chat can hand over. A
    // download is the browser saving bytes the app never reads.
    const big = Buffer.alloc(MAX_SHARED_FILE_BYTES + 1024, 7);
    await fs.writeFile(path.join(userRoot, "backup.img"), big);

    await expect(request("backup.img")).rejects.toThrow(/File too large/);

    const res = await downloadRequest("backup.img");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(big.length));
    expect((await body(res)).length).toBe(big.length);
  });

  it("encodes a non-ASCII download name for the client", async () => {
    const dir = userRoot;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Prüfbericht.pdf"), "%PDF-1.4");

    const res = await downloadRequest("Prüfbericht.pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Pr_fbericht.pdf"; filename*=UTF-8''Pr%C3%BCfbericht.pdf`,
    );
  });

  it("400s without a file parameter", async () => {
    const res = await GET(new NextRequest("http://localhost/api/chat/workspace-files"));
    expect(res.status).toBe(400);
  });
});

describe("workspace file serving for a coder chat", () => {
  // Computed lazily: `userRoot` only exists once the beforeAll has run.
  const worktree = () => path.join(userRoot, "worktrees", "proj", "chat-1");
  // What `CoderWorktree.path` holds: relative to the workspace root.
  const storedWorktree = "worktrees/proj/chat-1";

  it("serves a file from the named chat's worktree before the workspace root", async () => {
    await fs.mkdir(worktree(), { recursive: true });
    await fs.writeFile(path.join(worktree(), "notes.md"), "worktree notes");
    await fs.writeFile(path.join(userRoot, "notes.md"), "root notes");
    mockLoadChatCheckout.mockResolvedValue(chatCheckout(storedWorktree));

    const res = await sessionRequest("notes.md", "chat-1");

    expect(res.status).toBe(200);
    expect((await body(res)).toString()).toBe("worktree notes");
  });

  it("falls back to the workspace root when the worktree has no such file", async () => {
    await fs.mkdir(worktree(), { recursive: true });
    await fs.writeFile(path.join(userRoot, "notes.md"), "root notes");
    mockLoadChatCheckout.mockResolvedValue(chatCheckout(storedWorktree));

    const res = await sessionRequest("notes.md", "chat-1");

    expect(res.status).toBe(200);
    expect((await body(res)).toString()).toBe("root notes");
  });

  it("serves a worktree file for a download request", async () => {
    await fs.mkdir(worktree(), { recursive: true });
    await fs.writeFile(path.join(worktree(), "shot.png"), "png-bytes");
    mockLoadChatCheckout.mockResolvedValue(chatCheckout(storedWorktree));

    const res = await GET(
      new NextRequest(
        `http://localhost/api/chat/workspace-files?file=shot.png&session=chat-1&download=1`,
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="shot.png"; filename*=UTF-8''shot.png`,
    );
  });

  it("ignores a session whose worktree is stored outside the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "saale-outside-"));
    await fs.writeFile(path.join(outside, "leak.txt"), "top secret");
    mockLoadChatCheckout.mockResolvedValue(chatCheckout(outside));

    expect((await sessionRequest("leak.txt", "chat-1")).status).toBe(404);
  });
});
