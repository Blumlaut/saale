import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireChatSessionOwner,
  mockPrisma,
  mockIsConfigured,
  mockUploadFile,
  mockProcessAndStoreImage,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockPrisma: {
    chatMessage: {
      create: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
    chatSession: {
      update: vi.fn(),
    },
    chatAttachment: {
      findMany: vi.fn(),
    },
  },
  mockIsConfigured: vi.fn(() => true),
  mockUploadFile: vi.fn(),
  mockProcessAndStoreImage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireChatSessionOwner: mockRequireChatSessionOwner,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/redis", () => ({
  isSessionActive: vi.fn().mockResolvedValue(false),
  isSessionBusy: vi.fn().mockResolvedValue(false),
  registerActiveSession: vi.fn().mockResolvedValue(undefined),
  setPendingPrompt: vi.fn().mockResolvedValue(undefined),
  releaseSendQueue: vi.fn().mockResolvedValue(undefined),
}));

// Real file-attachment logic runs against a temp UPLOADS_DIR (stubbbed below),
// but the image re-encode (sharp) and the terminal transport are mocked.
vi.mock("@/lib/terminal/client", () => ({
  isConfigured: mockIsConfigured,
  uploadFile: mockUploadFile,
}));

vi.mock("@/lib/image-attachment", () => ({
  processAndStoreImage: mockProcessAndStoreImage,
  deleteAllImages: vi.fn(),
  deleteImage: vi.fn(),
  readImageAsBase64: vi.fn(),
  resolveImagePath: vi.fn(),
  validateImageUpload: vi.fn(),
  cleanupOrphanedImages: vi.fn(),
}));

let POST: typeof import("@/app/api/chat/sessions/[sessionId]/messages/route").POST;

const SESSION_ID = "session-1";
const USER_ID = "user-1";

let tmpRoot: string;

// `vi.resetModules()` forces a fresh import of the route, which pulls in its
// whole module graph — seconds of transform/import work, enough to blow the
// default 10s hook budget on a loaded machine.
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-msg-upload-"));
  vi.stubEnv("UPLOADS_DIR", tmpRoot);
  vi.resetModules();
  const mod = await import("@/app/api/chat/sessions/[sessionId]/messages/route");
  POST = mod.POST;
}, 60_000);

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A session record shaped like prisma.chatSession.findFirst(). */
function makeChatSession(title = "New Chat") {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    title,
    messageCount: 0,
    lastActivityAt: new Date(),
    toolConfig: null,
  } as never;
}

function authOk(session = makeChatSession()) {
  return { ok: true as const, session, userId: USER_ID };
}

function params() {
  return { params: Promise.resolve({ sessionId: SESSION_ID }) };
}

/** Build a multipart request the same way the chat client does. */
function multipartRequest(
  content: string,
  files: Array<[name: string, data: Uint8Array<ArrayBuffer>, type: string]>,
) {
  const formData = new FormData();
  formData.append("content", content);
  for (const [name, data, type] of files) {
    formData.append("files", new File([data], name, { type }));
  }
  return new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`, {
    method: "POST",
    body: formData,
  });
}

function jsonRequest(content: string) {
  return new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/** Stub the DB round-trips the route performs after create(). */
function stubDbMessage(messageId: string, attachments: unknown[] = []) {
  const messageRecord = {
    id: messageId,
    role: "user",
    content: "",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    attachments,
  };
  mockPrisma.chatMessage.create.mockResolvedValue(messageRecord);
  mockPrisma.chatMessage.findUnique.mockResolvedValue(messageRecord);
  mockPrisma.chatSession.update.mockResolvedValue({});
}

function createData() {
  return vi.mocked(mockPrisma.chatMessage.create).mock.calls[0]![0]!.data as {
    content: string;
    attachments?: { create: Array<Record<string, unknown>> };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue(authOk());
  mockIsConfigured.mockReturnValue(true);
  // Mirror the real server: path = <home>/<directory>/<fileName>
  mockUploadFile.mockImplementation(
    async (name: string, buf: Buffer, opts: { directory: string }) => ({
      path: `/home/user0001/${opts.directory}/${name}`,
      size: buf.length,
    }),
  );
  mockProcessAndStoreImage.mockResolvedValue({
    storageId: "img-uuid",
    storagePath: "images/img-uuid.png",
    width: 100,
    height: 50,
  });
});

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("POST multipart with file attachments", () => {
  it("stores a non-image file and appends its agent-workspace path to the message", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    stubDbMessage("msg-1");

    const res = await POST(
      multipartRequest("check this out", [["report.pdf", pdfBytes, "application/pdf"]]),
      params(),
    );

    expect(res.status).toBe(200);

    // The message content carries the file reference the model reads.
    expect(createData().content).toBe(
      "check this out\n[File attached: report.pdf (application/pdf) at /home/user0001/uploads/report.pdf]",
    );

    // The attachment record points at the host-side copy under files/.
    const att = createData().attachments!.create[0]!;
    expect(att.fileName).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.storagePath).toMatch(/^files\/[0-9a-f-]{36}-report\.pdf$/);
    expect(att.width).toBeNull();
    expect(att.height).toBeNull();

    // The file was delivered into the agent workspace.
    expect(mockUploadFile).toHaveBeenCalledWith(
      "report.pdf",
      expect.any(Buffer),
      expect.objectContaining({ directory: "uploads", userId: USER_ID }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.streamUrl).toBe(`/api/chat/sessions/${SESSION_ID}/stream`);
  });

  it("stores a file-only message (empty text) and titles the session after the file", async () => {
    stubDbMessage("msg-2", [{ id: "att-1" }]);

    const res = await POST(
      multipartRequest("", [["photo.png", new Uint8Array([1]), "image/png"]]),
      params(),
    );

    expect(res.status).toBe(200);

    expect(createData().content).toBe(
      "[Image attached: photo.png (image/png) at /home/user0001/uploads/photo.png]",
    );

    // Re-encoded image keeps the existing storagePath + dimensions.
    const att = createData().attachments!.create[0]!;
    expect(att.storagePath).toBe("images/img-uuid.png");
    expect(att.width).toBe(100);
    expect(att.height).toBe(50);

    // Session title falls back to the file name for file-only messages.
    const updateCall = vi.mocked(mockPrisma.chatSession.update).mock.calls[0]![0]!;
    expect((updateCall.data as { title: string }).title).toBe("photo.png");
  });

  it("accepts arbitrary file types (zip, csv, unknown)", async () => {
    stubDbMessage("msg-3");

    const res = await POST(
      multipartRequest("files", [
        ["archive.zip", new Uint8Array([0x50, 0x4b]), "application/zip"],
        ["data.csv", new Uint8Array([0x61, 0x2c, 0x62]), "text/csv"],
        ["blob.bin", new Uint8Array([0x00, 0x01]), ""],
      ]),
      params(),
    );

    expect(res.status).toBe(200);
    expect(mockUploadFile).toHaveBeenCalledTimes(3);
  });
});

// ─── Terminal degradation ────────────────────────────────────────────────────

describe("terminal workspace delivery", () => {
  it("skips delivery and omits the path when the terminal is not configured", async () => {
    mockIsConfigured.mockReturnValue(false);
    stubDbMessage("msg-4");

    const res = await POST(
      multipartRequest("hi", [["data.csv", new Uint8Array([1]), "text/csv"]]),
      params(),
    );

    expect(res.status).toBe(200);
    expect(mockUploadFile).not.toHaveBeenCalled();

    expect(createData().content).toBe("hi\n[File attached: data.csv (text/csv)]");
  });

  it("fails the request when the terminal is configured but the upload fails", async () => {
    mockUploadFile.mockRejectedValue(new Error("Open Terminal error 502: Bad Gateway"));

    const res = await POST(
      multipartRequest("hi", [["report.pdf", new Uint8Array([1]), "application/pdf"]]),
      params(),
    );

    expect(res.status).toBe(500);
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.error).toMatch(/Open Terminal error 502/);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("upload validation", () => {
  it("rejects empty files with 400", async () => {
    const res = await POST(
      multipartRequest("hi", [["empty.txt", new Uint8Array([]), "text/plain"]]),
      params(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("File is empty");
  });

  it("rejects oversized files with 400", async () => {
    const oversized = new Uint8Array(15 * 1024 * 1024 + 1);
    const res = await POST(
      multipartRequest("hi", [["big.bin", oversized, "application/octet-stream"]]),
      params(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/File too large/);
  });

  it("rejects a multipart with neither text nor files", async () => {
    const res = await POST(multipartRequest("   ", []), params());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Content is required");
  });
});

// ─── Regressions ─────────────────────────────────────────────────────────────

describe("plain JSON messages (no attachments)", () => {
  it("stores the content untouched", async () => {
    stubDbMessage("msg-5");

    const res = await POST(jsonRequest("hello world"), params());

    expect(res.status).toBe(200);
    expect(createData().content).toBe("hello world");
    expect(createData().attachments).toBeUndefined();
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("returns the auth failure response for other users' sessions", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });

    const res = await POST(jsonRequest("hello"), params());
    expect(res.status).toBe(404);
  });
});
