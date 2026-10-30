import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { userWorkspacePath } from "@/lib/sandbox/workspace";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireChatSessionOwner, mockPrisma, mockProcessAndStoreImage } = vi.hoisted(() => ({
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

// Real file-attachment logic runs against a temp workspaces volume (stubbed
// below); only the image re-encode (sharp) is mocked.

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
/** The user's workspace directory inside the stubbed volume. */
let userRoot: string;

// `vi.resetModules()` forces a fresh import of the route, which pulls in its
// whole module graph  seconds of transform/import work, enough to blow the
// default 10s hook budget on a loaded machine.
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-msg-upload-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", tmpRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  userRoot = userWorkspacePath(USER_ID);
  vi.resetModules();
  const mod = await import("@/app/api/chat/sessions/[sessionId]/messages/route");
  POST = mod.POST;
}, 60_000);

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A session record shaped like prisma.chatSession.findFirst(). */
function makeChatSession(title = "New Chat", titleSource = "default") {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    title,
    titleSource,
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

/** Leave bytes where the chunked upload endpoints would have, and name them. */
async function stageUpload(
  name: string,
  data: Uint8Array,
  type: string,
): Promise<{ uploadId: string; fileName: string; mimeType: string; size: number }> {
  const uploadId = randomUUID();
  const staging = path.join(userRoot, ".tmp");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, `upload-${uploadId}`), data);
  return { uploadId, fileName: name, mimeType: type, size: data.length };
}

/** A message carrying staged attachments, the way the composer sends one. */
function attachmentRequest(
  content: string,
  attachments: Array<{ uploadId: string; fileName: string; mimeType: string; size: number }>,
) {
  return new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, attachments }),
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
  // mirrors the row the route wrote, so the response carries the real title
  mockPrisma.chatSession.update.mockImplementation(async (args: { data: { title?: string } }) => ({
    title: args.data.title,
  }));
}

function createData() {
  return vi.mocked(mockPrisma.chatMessage.create).mock.calls[0]![0]!.data as {
    content: string;
    attachments?: { create: Array<Record<string, unknown>> };
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue(authOk());
  await fs.rm(userRoot, { recursive: true, force: true });
  mockProcessAndStoreImage.mockResolvedValue({
    storageId: "img-uuid",
    storagePath: "images/img-uuid.png",
    width: 100,
    height: 50,
  });
});

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("POST with staged attachments", () => {
  it("stores a non-image file and appends its agent-workspace path to the message", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    stubDbMessage("msg-1");
    const staged = await stageUpload("report.pdf", pdfBytes, "application/pdf");

    const res = await POST(attachmentRequest("check this out", [staged]), params());

    expect(res.status).toBe(200);

    // The message content carries the file reference the model reads.
    expect(createData().content).toBe(
      `check this out\n[File attached: report.pdf (application/pdf) at ${path.join(userRoot, "uploads", "report.pdf")}]`,
    );

    // The attachment record points at the host-side copy under files/.
    const att = createData().attachments!.create[0]!;
    expect(att.fileName).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.storagePath).toMatch(/^files\/[0-9a-f-]{36}-report\.pdf$/);
    expect(att.width).toBeNull();
    expect(att.height).toBeNull();

    // The file was delivered into the agent workspace under its own name.
    expect(await fs.readFile(path.join(userRoot, "uploads", "report.pdf"))).toEqual(
      Buffer.from(pdfBytes),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.streamUrl).toBe(`/api/chat/sessions/${SESSION_ID}/stream`);
  });

  it("stores a file-only message (empty text) and titles the session after the file", async () => {
    stubDbMessage("msg-2", [{ id: "att-1" }]);
    const staged = await stageUpload("photo.png", new Uint8Array([1]), "image/png");

    const res = await POST(attachmentRequest("", [staged]), params());

    expect(res.status).toBe(200);

    expect(createData().content).toBe(
      `[Image attached: photo.png (image/png) at ${path.join(userRoot, "uploads", "photo.png")}]`,
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
      attachmentRequest("files", [
        await stageUpload("archive.zip", new Uint8Array([0x50, 0x4b]), "application/zip"),
        await stageUpload("data.csv", new Uint8Array([0x61, 0x2c, 0x62]), "text/csv"),
        await stageUpload("blob.bin", new Uint8Array([0x00, 0x01]), "application/octet-stream"),
      ]),
      params(),
    );

    expect(res.status).toBe(200);
    expect(await fs.readdir(path.join(userRoot, "uploads")).then((names) => names.sort())).toEqual([
      "archive.zip",
      "blob.bin",
      "data.csv",
    ]);
  });
});

// ─── Workspace delivery ──────────────────────────────────────────────────────

describe("workspace delivery", () => {
  it("fails the request when the workspace cannot be written", async () => {
    const staged = await stageUpload("report.pdf", new Uint8Array([1]), "application/pdf");
    // A file where uploads/ should be: the copy the agent reads fails.
    await fs.writeFile(path.join(userRoot, "uploads"), "not a directory");
    stubDbMessage("msg-4");

    const res = await POST(attachmentRequest("hi", [staged]), params());

    expect(res.status).toBe(500);
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.error).toMatch(/uploads/);

    await fs.rm(path.join(userRoot, "uploads"), { force: true });
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("upload validation", () => {
  it("rejects empty files with 400", async () => {
    const staged = await stageUpload("empty.txt", new Uint8Array([]), "text/plain");
    const res = await POST(attachmentRequest("hi", [staged]), params());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("File is empty");
  });

  it("rejects oversized files with 400", async () => {
    // No bytes on disk: the size check runs before anything is read.
    const res = await POST(
      attachmentRequest("hi", [
        {
          uploadId: randomUUID(),
          fileName: "big.png",
          mimeType: "image/png",
          size: 16 * 1024 * 1024,
        },
      ]),
      params(),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/File too large/);
  });

  it("rejects an attachment that was never staged", async () => {
    const res = await POST(
      attachmentRequest("hi", [
        { uploadId: randomUUID(), fileName: "gone.pdf", mimeType: "application/pdf", size: 4 },
      ]),
      params(),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/gone.pdf/);
  });

  it("rejects a message with neither text nor files", async () => {
    const res = await POST(attachmentRequest("   ", []), params());
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
    await expect(fs.access(path.join(userRoot, "uploads"))).rejects.toThrow();
  });

  it("names the chat from the first message instead of quoting it", async () => {
    stubDbMessage("msg-6");

    const res = await POST(
      jsonRequest("can you add a dark mode toggle to the settings page"),
      params(),
    );

    expect(res.status).toBe(200);
    const update = vi.mocked(mockPrisma.chatSession.update).mock.calls[0]![0]!.data as {
      title: string;
      titleSource: string;
    };
    expect(update.title).toBe("Add dark mode toggle to settings page");
    expect(update.titleSource).toBe("auto");

    // the sidebar and the chat header read the same title without a reload
    expect((await res.json()).title).toBe("Add dark mode toggle to settings page");
  });

  it("leaves a chat that already has a title alone", async () => {
    mockRequireChatSessionOwner.mockResolvedValue(authOk(makeChatSession("Trip planning", "user")));
    stubDbMessage("msg-8");

    await POST(jsonRequest("add a dark mode toggle to the settings page"), params());

    const update = vi.mocked(mockPrisma.chatSession.update).mock.calls[0]![0]!.data as Record<
      string,
      unknown
    >;
    expect("title" in update).toBe(false);
    expect("titleSource" in update).toBe(false);
  });

  it("quotes the prompt when it cannot name a topic", async () => {
    stubDbMessage("msg-7");

    await POST(jsonRequest("hi"), params());

    const update = vi.mocked(mockPrisma.chatSession.update).mock.calls[0]![0]!.data as {
      title: string;
      titleSource?: string;
    };
    expect(update.title).toBe("hi");
    // left open for the next message to name the chat
    expect(update.titleSource).toBeUndefined();
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
