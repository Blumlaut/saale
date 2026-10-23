import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockGetLiveRunEvents = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/pi/sse-buffer", () => ({
  getLiveRunEvents: (...args: unknown[]) => mockGetLiveRunEvents(...args),
}));

// subscribeSessionEvents: register the listener; resolve with an unsubscribe.
let busListeners = new Set<(evt: { id: number; event: string; data: unknown }) => void>();
const mockSubscribeSessionEvents = vi.fn((sessionId: string, listener: (evt: unknown) => void) => {
  busListeners.add(listener as never);
  return Promise.resolve(() => {
    busListeners.delete(listener as never);
  });
});
vi.mock("@/lib/pi/session-events", () => ({
  subscribeSessionEvents: (...args: unknown[]) =>
    mockSubscribeSessionEvents(...(args as [string, (evt: unknown) => void])),
}));

import { SseDispatcher } from "@/lib/pi/sse-dispatcher";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockController() {
  const chunks: Uint8Array[] = [];
  const enqueueMock = vi.fn((chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  return {
    controller: {
      enqueue: enqueueMock,
      close: vi.fn(),
    } as unknown as ReadableStreamDefaultController,
    chunks,
    encoder: new TextEncoder(),
    enqueueMock,
  };
}

function decodeChunks(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c)).join("");
}

/** Simulate a live event arriving on the bus for the session. */
function emitLive(dispatcher: SseDispatcher, id: number, event: string, data: unknown) {
  for (const listener of busListeners) {
    listener({ id, event, data });
  }
}

describe("SseDispatcher", () => {
  let dispatcher: SseDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    busListeners = new Set();
    mockGetLiveRunEvents.mockResolvedValue([]);
    mockSubscribeSessionEvents.mockImplementation(
      (_sessionId: string, listener: (evt: unknown) => void) => {
        busListeners.add(listener as never);
        return Promise.resolve(() => {
          busListeners.delete(listener as never);
        });
      },
    );
    dispatcher = new SseDispatcher("session-1");
  });

  describe("subscribe", () => {
    it("subscribes to the bus and registers the client", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      expect(mockSubscribeSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
      expect(dispatcher.clientCount).toBe(1);
    });

    it("supports multiple concurrent clients (fan-out)", async () => {
      const a = createMockController();
      const b = createMockController();
      await dispatcher.subscribe(a.controller, a.encoder, -1);
      await dispatcher.subscribe(b.controller, b.encoder, -1);

      expect(dispatcher.clientCount).toBe(2);

      emitLive(dispatcher, 1, "turn_start", { turnId: "t1" });
      emitLive(dispatcher, 2, "token", { turnId: "t1", text: "hello" });

      expect(a.enqueueMock).toHaveBeenCalledTimes(2);
      expect(b.enqueueMock).toHaveBeenCalledTimes(2);
      expect(decodeChunks(a.chunks)).toContain("id: 2");
      expect(decodeChunks(b.chunks)).toContain('{"turnId":"t1","text":"hello"}');
    });

    it("replays the live run's events after lastEventId", async () => {
      mockGetLiveRunEvents.mockResolvedValueOnce([
        { id: 3, event: "token", data: { turnId: "t1", text: "third" } },
        { id: 4, event: "turn_end", data: { turnId: "t1" } },
      ]);
      const mock = createMockController();

      await dispatcher.subscribe(mock.controller, mock.encoder, 2);

      expect(mockGetLiveRunEvents).toHaveBeenCalledWith("session-1", 2);
      expect(decodeChunks(mock.chunks)).toContain("id: 3");
      expect(decodeChunks(mock.chunks)).toContain("id: 4");
    });

    it("replays a whole live run for a fresh connect (lastEventId = -1)", async () => {
      mockGetLiveRunEvents.mockResolvedValueOnce([
        { id: 1, event: "turn_start", data: { turnId: "t1" } },
        { id: 2, event: "token", data: { turnId: "t1", text: "hi" } },
      ]);
      const mock = createMockController();

      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      expect(mockGetLiveRunEvents).toHaveBeenCalledWith("session-1", -1);
      expect(decodeChunks(mock.chunks)).toContain("event: turn_start");
      expect(decodeChunks(mock.chunks)).toContain("event: token");
    });

    it("does not duplicate events delivered live during the replay", async () => {
      // The bus delivers id 5 live while the buffer query is in flight;
      // the buffer then returns the same event  it must be delivered once.
      const mock = createMockController();
      mockGetLiveRunEvents.mockResolvedValue([
        { id: 5, event: "token", data: { text: "once" } },
        { id: 6, event: "token", data: { text: "twice" } },
      ]);

      await dispatcher.subscribe(mock.controller, mock.encoder, 3);
      // Simulate live delivery racing the replay (buffer query already started):
      emitLive(dispatcher, 5, "token", { text: "once" });

      // id 5 was already forwarded via replay; the live duplicate must be dropped.
      const outputs = decodeChunks(mock.chunks);
      expect(outputs.match(/event: token/g)).toHaveLength(2);
      expect(outputs).toContain('{"text":"once"}');
      expect(outputs).toContain('{"text":"twice"}');
    });

    it("forwards events published after the replay (live path)", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      emitLive(dispatcher, 7, "token", { turnId: "t1", text: "live" });

      expect(mock.enqueueMock).toHaveBeenCalledTimes(1);
      expect(decodeChunks(mock.chunks)).toContain("id: 7");
    });

    it("delivers events after an event-ID reset (long tool call, counter expiry)", async () => {
      // Regression: a client was connected through a generation that went
      // quiet (long tool call) long enough for the Redis counter to reset.
      // New events now carry LOW ids (1, 2, 3) even though the client has
      // seen ids up to 42. A watermark-based dedupe would skip them all and
      // the stream would look dead while Pi keeps working. The seen-ID set
      // must deliver them.
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, 42);
      mock.enqueueMock.mockClear();

      emitLive(dispatcher, 1, "tool_end", { toolCallId: "tc-1", result: "done", isError: false });
      emitLive(dispatcher, 2, "token", { turnId: "t1", text: "resumed" });
      emitLive(dispatcher, 3, "done", {});

      expect(mock.enqueueMock).toHaveBeenCalledTimes(3);
      const output = decodeChunks(mock.chunks);
      expect(output).toContain("event: tool_end");
      expect(output).toContain("event: token");
      expect(output).toContain("event: done");
    });

    it("dedupes only what the client has actually seen (not a watermark)", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      // id 5 arrives live; the replay then re-delivers it  dropped.
      emitLive(dispatcher, 5, "token", { text: "first" });
      emitLive(dispatcher, 5, "token", { text: "first" });
      // But a NEW event with an id BELOW 5 (post-reset) must still flow.
      emitLive(dispatcher, 3, "token", { text: "post-reset" });

      expect(mock.enqueueMock).toHaveBeenCalledTimes(2);
      const output = decodeChunks(mock.chunks);
      expect(output).toContain('{"text":"first"}');
      expect(output).toContain('{"text":"post-reset"}');
    });

    it("is a no-op when the controller is already subscribed", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      expect(mockSubscribeSessionEvents).toHaveBeenCalledTimes(1);
      expect(dispatcher.clientCount).toBe(1);
    });
  });

  describe("unsubscribe", () => {
    it("drops the client and unsubscribes the bus when none remain", async () => {
      const a = createMockController();
      const b = createMockController();
      await dispatcher.subscribe(a.controller, a.encoder, -1);
      await dispatcher.subscribe(b.controller, b.encoder, -1);

      dispatcher.unsubscribe(a.controller);
      expect(dispatcher.clientCount).toBe(1);
      expect(busListeners.size).toBe(1);

      dispatcher.unsubscribe(b.controller);
      expect(dispatcher.clientCount).toBe(0);
      expect(busListeners.size).toBe(0);
    });
  });

  describe("emitLocal", () => {
    it("sends an event to one client without buffering (no id line)", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      dispatcher.emitLocal(mock.controller, "done", {});

      const output = decodeChunks(mock.chunks);
      expect(output).toContain("event: done");
      expect(output).toContain("data: {}");
      // Unbuffered events omit the id field.
      expect(output).not.toContain("id:");
    });

    it("does nothing for an unknown controller", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);
      const other = createMockController();

      dispatcher.emitLocal(other.controller, "done", {});

      expect(mock.enqueueMock).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears all clients, closes their controllers, and unsubscribes the bus", async () => {
      const a = createMockController();
      const b = createMockController();
      await dispatcher.subscribe(a.controller, a.encoder, -1);
      await dispatcher.subscribe(b.controller, b.encoder, -1);

      await dispatcher.dispose();

      expect(dispatcher.clientCount).toBe(0);
      expect(busListeners.size).toBe(0);
      // Controllers are closed so clients' EventSources reconnect and
      // re-subscribe to a fresh dispatcher (self-healing after eviction).
      expect(a.controller.close).toHaveBeenCalledTimes(1);
      expect(b.controller.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("SSE event format", () => {
    it("emits id, event, data lines in order", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      emitLive(dispatcher, 42, "done", {});

      const lines = decodeChunks(mock.chunks).split("\n");
      expect(lines[0]).toBe("id: 42");
      expect(lines[1]).toBe("event: done");
      expect(lines[2]).toBe("data: {}");
    });

    it("escapes newlines in data", async () => {
      const mock = createMockController();
      await dispatcher.subscribe(mock.controller, mock.encoder, -1);

      emitLive(dispatcher, 1, "token", { text: "line1\nline2" });

      const lines = decodeChunks(mock.chunks).split("\n");
      expect(lines).toHaveLength(5); // id, event, data, empty, empty
      const dataJson = lines[2]!.slice("data: ".length);
      expect(JSON.parse(dataJson).text).toBe("line1\nline2");
    });
  });
});
