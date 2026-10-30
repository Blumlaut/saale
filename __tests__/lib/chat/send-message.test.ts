import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockStageFile } = vi.hoisted(() => ({ mockStageFile: vi.fn() }));

vi.mock("@/lib/files/upload-client", () => ({ stageFile: mockStageFile }));

import { sendChatMessage } from "@/lib/chat/send-message";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockStageFile.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

/** A file whose declared size the test chooses, without allocating the bytes. */
function sizedFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("sendChatMessage", () => {
  it("posts plain text as JSON with the content-type header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m1" }, queued: false }));
    const result = await sendChatMessage("sess-1", "hello");

    expect(result).toEqual({ kind: "ok", message: { id: "m1" }, queued: false, steered: false });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("/api/chat/sessions/sess-1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ content: "hello" });
  });

  it("carries the chat title the message produced", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: { id: "m4" }, queued: false, title: "Dark mode toggle" }),
    );
    const result = await sendChatMessage("sess-1", "add a dark mode toggle");

    expect(result.kind === "ok" && result.title).toBe("Dark mode toggle");
  });

  it("flags a message the server queued instead of prompting", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m2" }, queued: true }));
    expect(await sendChatMessage("sess-1", "hello")).toEqual({
      kind: "ok",
      message: { id: "m2" },
      queued: true,
      steered: false,
    });
  });

  it("surfaces the steered flag when the message interrupted a pending approval", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: { id: "m3" }, queued: false, steered: true }),
    );
    expect(await sendChatMessage("sess-1", "do this instead")).toEqual({
      kind: "ok",
      message: { id: "m3" },
      queued: false,
      steered: true,
    });
  });

  it("stages files first and posts their ids with the message", async () => {
    mockStageFile.mockResolvedValueOnce({
      ok: true,
      staged: {
        uploadId: "u-1",
        fileName: "snapshot.tar",
        size: 42,
        mimeType: "application/x-tar",
      },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m1" } }));
    const file = sizedFile("snapshot.tar", "application/x-tar", 42);

    await sendChatMessage("sess-1", "look", [file]);

    // The bytes went up in chunks, each named after the same staged upload.
    expect(mockStageFile).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ target: "user", batch: { index: 1, count: 1 } }),
    );

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("/api/chat/sessions/sess-1/messages");
    expect(JSON.parse(init.body as string)).toEqual({
      content: "look",
      attachments: [
        { uploadId: "u-1", fileName: "snapshot.tar", size: 42, mimeType: "application/x-tar" },
      ],
    });
  });

  it("refuses a file over the ceiling before staging it", async () => {
    const result = await sendChatMessage("sess-1", "look", [
      sizedFile("snapshot.tar", "application/x-tar", 251 * 1024 * 1024),
    ]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toMatch(/snapshot.tar is 251.0 MB/);
    expect(mockStageFile).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports why a staged upload was refused", async () => {
    mockStageFile.mockResolvedValueOnce({
      ok: false,
      name: "snapshot.tar",
      reason: "too-large",
      message: "File is larger than 2.0 GB",
    });

    const result = await sendChatMessage("sess-1", "look", [new File(["x"], "snapshot.tar")]);

    expect(result).toEqual({ kind: "error", message: "File is larger than 2.0 GB" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps 409 to conflict", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "busy" }, 409));
    expect(await sendChatMessage("s", "hi")).toEqual({ kind: "conflict" });
  });

  it("maps 404 to not-found", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    expect(await sendChatMessage("s", "hi")).toEqual({ kind: "not-found" });
  });

  it("maps other failures to error with the server message", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    expect(await sendChatMessage("s", "hi")).toEqual({ kind: "error", message: "boom" });
  });

  it("falls back to statusText when the error body is missing", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 500, statusText: "Internal Error" }),
    );
    expect(await sendChatMessage("s", "hi")).toEqual({
      kind: "error",
      message: "Internal Error",
    });
  });

  it("reports a missing message in a 2xx response as an error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    expect(await sendChatMessage("s", "hi")).toEqual({
      kind: "error",
      message: "Missing message in response",
    });
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m1" } }));
    await sendChatMessage("s", "hi", undefined, { signal: controller.signal });
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.signal).toBe(controller.signal);
  });

  it("omits the signal when none is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m1" } }));
    await sendChatMessage("s", "hi");
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.signal).toBeNull();
  });
});
