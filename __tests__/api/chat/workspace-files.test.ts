import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireSession, mockIsConfigured, mockGetTerminalHomeDir, mockReadFileBinary } =
  vi.hoisted(() => ({
    mockRequireSession: vi.fn(),
    mockIsConfigured: vi.fn(() => false),
    mockGetTerminalHomeDir: vi.fn((userId: string) => `/home/${userId}`),
    mockReadFileBinary: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({
  requireSession: mockRequireSession,
}));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: mockIsConfigured,
  getTerminalHomeDir: mockGetTerminalHomeDir,
  readFileBinary: mockReadFileBinary,
}));

let GET: typeof import("@/app/api/chat/workspace-files/route").GET;

const USER_ID = "user-1";
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspace-files-"));
  vi.stubEnv("UPLOADS_DIR", tmpRoot);
  vi.resetModules();
  GET = (await import("@/app/api/chat/workspace-files/route")).GET;
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConfigured.mockReturnValue(false);
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function request(file: string, ifNoneMatch?: string) {
  const req = new NextRequest(
    `http://localhost/api/chat/workspace-files?file=${encodeURIComponent(file)}`,
    { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} },
  );
  return GET(req);
}

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// ─── Mutable file at a stable URL ────────────────────────────────────────────

describe("workspace file serving", () => {
  /**
   * The whole point: `report.pdf` keeps its path while an agent rewrites it, so
   * the download URL never changes. A long-lived `max-age` made the browser
   * replay the first (pre-edit) bytes forever — the file had to be renamed to
   * be downloadable in its updated state.
   */
  it("serves the updated bytes from an unchanged URL, and 304s on unchanged content", async () => {
    const dir = path.join(tmpRoot, USER_ID);
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
    const dir = path.join(tmpRoot, USER_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "hello");

    const first = await request("notes.txt");
    const etag = first.headers.get("etag")!;

    expect((await request("notes.txt", `W/${etag}`)).status).toBe(304);
    expect((await request("notes.txt", `"other", ${etag}`)).status).toBe(304);
    expect((await request("notes.txt", '"unrelated"')).status).toBe(200);
  });

  it("serves through Open Terminal and stays fresh when the container file changes", async () => {
    mockIsConfigured.mockReturnValue(true);

    const original = Buffer.from("%PDF-1.4 container original");
    mockReadFileBinary.mockResolvedValueOnce({ mimeType: "application/pdf", buffer: original });

    const first = await request("uploads/report.pdf");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/pdf");
    expect((await body(first)).equals(original)).toBe(true);

    const etag = first.headers.get("etag")!;
    expect(mockReadFileBinary).toHaveBeenCalledWith(
      `/home/${USER_ID}/uploads/report.pdf`,
      expect.objectContaining({ userId: USER_ID }),
    );

    const edited = Buffer.from("%PDF-1.4 container edited");
    mockReadFileBinary.mockResolvedValueOnce({ mimeType: "application/pdf", buffer: edited });

    const second = await request("uploads/report.pdf", etag);
    expect(second.status).toBe(200);
    expect((await body(second)).equals(edited)).toBe(true);
  });

  it("rejects paths that escape the workspace", async () => {
    const res = await request("../../etc/passwd");
    expect(res.status).toBe(403);
  });

  it("404s a missing file", async () => {
    expect((await request("nope.pdf")).status).toBe(404);
  });

  it("400s without a file parameter", async () => {
    const res = await GET(new NextRequest("http://localhost/api/chat/workspace-files"));
    expect(res.status).toBe(400);
  });
});
