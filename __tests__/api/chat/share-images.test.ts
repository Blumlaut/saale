import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: vi.fn() },
    chatMessage: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/files/workspace-file", () => ({ readWorkspaceFile: vi.fn() }));

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { GET } from "@/app/api/chat/sessions/share/[token]/images/[callId]/route";

/** A tool call as the message row stores it, with the result the tool wrote. */
function storedCall(id: string, name: string, meta: Record<string, unknown>): string {
  return JSON.stringify([
    {
      id,
      name,
      args: {},
      result: `Rendered it\n${JSON.stringify(meta)}`,
      isError: false,
    },
  ]);
}

const RENDERED = storedCall("call-1", "generate_image", {
  _saaleImageMeta: {
    path: "generated/9b1c.png",
    model: "qwen-image-2.1-turbo",
    provider: "custom",
    prompt: "A red fox in the snow",
    width: 1024,
    height: 1024,
  },
});

function request(token = "tok", callId = "call-1") {
  return GET(new Request("http://localhost"), { params: Promise.resolve({ token, callId }) });
}

describe("GET /api/chat/sessions/share/:token/images/:callId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.chatSession.findFirst).mockResolvedValue({
      id: "session-1",
      userId: "owner-1",
      shareAccess: "public",
    } as never);
    vi.mocked(prisma.chatMessage.findFirst).mockResolvedValue({ toolCalls: RENDERED } as never);
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      fileName: "9b1c.png",
      mimeType: "image/png",
      size: 4,
      buffer: new Uint8Array([1, 2, 3, 4]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the picture that call rendered, out of the owner's workspace", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    // Unsharing has to take the picture with it.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(readWorkspaceFile).toHaveBeenCalledWith("owner-1", "generated/9b1c.png");
  });

  it("answers 404 for a token that is not shared", async () => {
    vi.mocked(prisma.chatSession.findFirst).mockResolvedValue(null);

    expect((await request()).status).toBe(404);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("answers 401 for a gated chat without a signed-in viewer", async () => {
    vi.mocked(prisma.chatSession.findFirst).mockResolvedValue({
      id: "session-1",
      userId: "owner-1",
      shareAccess: "signed-in",
    } as never);

    expect((await request()).status).toBe(401);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("serves a gated chat to a signed-in viewer", async () => {
    vi.mocked(prisma.chatSession.findFirst).mockResolvedValue({
      id: "session-1",
      userId: "owner-1",
      shareAccess: "signed-in",
    } as never);
    vi.mocked(getSession).mockResolvedValue({ user: { id: "viewer-1" } } as never);

    expect((await request()).status).toBe(200);
  });

  it("ignores a call id that is not in the chat", async () => {
    vi.mocked(prisma.chatMessage.findFirst).mockResolvedValue(null);

    expect((await request()).status).toBe(404);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  // The path comes from the call's own result, so a chat tool call cannot name
  // a file for this route to serve.
  it("serves nothing for a call that rendered no picture", async () => {
    vi.mocked(prisma.chatMessage.findFirst).mockResolvedValue({
      toolCalls: storedCall("call-1", "bash", { _saaleImageMeta: { path: "generated/9b1c.png" } }),
    } as never);

    expect((await request()).status).toBe(404);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("refuses a picture from outside the generated directory", async () => {
    vi.mocked(prisma.chatMessage.findFirst).mockResolvedValue({
      toolCalls: storedCall("call-1", "generate_image", {
        _saaleImageMeta: { path: "../../etc/passwd" },
      }),
    } as never);

    expect((await request()).status).toBe(404);
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("answers 404 when the workspace no longer holds the file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readWorkspaceFile).mockRejectedValue(new Error("File not found"));

    expect((await request()).status).toBe(404);
  });

  it("is a 404 rather than a crash when the stored column is not JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.chatMessage.findFirst).mockResolvedValue({ toolCalls: "{nope" } as never);

    expect((await request()).status).toBe(404);
  });

  // Guard against a route that quietly answers 200 with an error body.
  it("answers with the bytes themselves", async () => {
    const response = await request();
    const body = new Uint8Array(await response.arrayBuffer());

    expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
