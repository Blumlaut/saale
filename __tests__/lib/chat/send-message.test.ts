import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChatMessage } from "@/lib/chat/send-message";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

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

  it("sends files as multipart form data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: { id: "m1" } }));
    const file = new File(["x"], "x.png", { type: "image/png" });

    await sendChatMessage("sess-1", "look", [file]);

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("content")).toBe("look");
    expect((init.body as FormData).getAll("files")).toHaveLength(1);
    // No content-type header  the browser sets the multipart boundary.
    expect(init.headers).toBeUndefined();
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
    await sendChatMessage("s", "hi", undefined, controller.signal);
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
