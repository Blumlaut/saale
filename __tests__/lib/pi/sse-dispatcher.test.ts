import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── SSE buffer mocks ───────────────────────────────────────────────────────

const mockBufferEvent = vi.fn().mockResolvedValue(1);
const mockClearBuffer = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/pi/sse-buffer", () => ({
  bufferEvent: (...args: unknown[]) => mockBufferEvent(...args),
  clearBuffer: (...args: unknown[]) => mockClearBuffer(...args),
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SseDispatcher", () => {
  let dispatcher: SseDispatcher;
  let mock: ReturnType<typeof createMockController>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBufferEvent.mockResolvedValue(1);
    mockClearBuffer.mockResolvedValue(undefined);
    dispatcher = new SseDispatcher("session-1");
    mock = createMockController();
  });

  describe("wire", () => {
    it("sets controller and encoder", () => {
      dispatcher.wire(mock.controller, mock.encoder);
      // Verify by emitting — if wired correctly, emit should work
      expect(dispatcher.isClosed).toBe(false);
    });

    it("closes old controller when rewiring", () => {
      const oldMock = createMockController();
      dispatcher.wire(oldMock.controller, oldMock.encoder);
      dispatcher.wire(mock.controller, mock.encoder);

      expect(oldMock.controller.close).toHaveBeenCalledTimes(1);
    });

    it("does not close old controller if already closed", () => {
      const oldMock = createMockController();
      dispatcher.wire(oldMock.controller, oldMock.encoder);
      dispatcher.close();
      dispatcher.wire(mock.controller, mock.encoder);

      // Old controller should NOT be closed again (already closed via dispatcher.close())
      expect(oldMock.controller.close).not.toHaveBeenCalled();
    });

    it("resets closed flag on rewire", () => {
      const oldMock = createMockController();
      dispatcher.wire(oldMock.controller, oldMock.encoder);
      dispatcher.close();
      expect(dispatcher.isClosed).toBe(true);

      dispatcher.wire(mock.controller, mock.encoder);
      expect(dispatcher.isClosed).toBe(false);
    });
  });

  describe("emit", () => {
    it("buffers event to Redis and sends to controller", async () => {
      mockBufferEvent.mockResolvedValueOnce(1);
      dispatcher.wire(mock.controller, mock.encoder);

      await dispatcher.emit("token", { text: "hello" });

      expect(mockBufferEvent).toHaveBeenCalledWith("session-1", "token", { text: "hello" });
      expect(mock.controller.enqueue).toHaveBeenCalledTimes(1);

      const output = decodeChunks(mock.chunks);
      expect(output).toContain("id: 1");
      expect(output).toContain("event: token");
      expect(output).toContain('{"text":"hello"}');
    });

    it("uses the buffered event ID in the SSE payload", async () => {
      mockBufferEvent.mockResolvedValueOnce(42);
      dispatcher.wire(mock.controller, mock.encoder);

      await dispatcher.emit("done", {});

      const output = decodeChunks(mock.chunks);
      expect(output).toContain("id: 42");
      expect(output).toContain("event: done");
    });

    it("handles Redis failure gracefully (falls back to ID -1)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockBufferEvent.mockRejectedValueOnce(new Error("Redis down"));
      dispatcher.wire(mock.controller, mock.encoder);

      await dispatcher.emit("token", { text: "hello" });

      // Should still send to controller with ID -1
      expect(mock.controller.enqueue).toHaveBeenCalledTimes(1);
      const output = decodeChunks(mock.chunks);
      expect(output).toContain("id: -1");

      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to buffer SSE event"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });

    it("skips enqueue when dispatcher is closed", async () => {
      mockBufferEvent.mockResolvedValueOnce(1);
      dispatcher.wire(mock.controller, mock.encoder);
      dispatcher.close();

      await dispatcher.emit("token", { text: "hello" });

      // Buffer should still be called (Redis is the source of truth)
      expect(mockBufferEvent).toHaveBeenCalledTimes(1);
      // But controller should not receive the event
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });

    it("skips enqueue when not wired", async () => {
      mockBufferEvent.mockResolvedValueOnce(1);

      await dispatcher.emit("token", { text: "hello" });

      expect(mockBufferEvent).toHaveBeenCalledTimes(1);
      // No controller to enqueue to
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });

    it("handles controller enqueue failure gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockBufferEvent.mockResolvedValueOnce(1);
      mock.enqueueMock.mockImplementationOnce(() => {
        throw new Error("Controller error");
      });
      dispatcher.wire(mock.controller, mock.encoder);

      await dispatcher.emit("token", { text: "hello" });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to enqueue SSE event"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });

    it("escapes newlines in data", async () => {
      mockBufferEvent.mockResolvedValueOnce(1);
      dispatcher.wire(mock.controller, mock.encoder);

      await dispatcher.emit("token", { text: "line1\nline2\rline3" });

      const output = decodeChunks(mock.chunks);
      // The JSON.stringify already escapes newlines as \n (two chars)
      // Then formatSseEvent escapes them again as \\n
      // The output should be a valid SSE event (single data line)
      const lines = output.split("\n");
      // id: line, event: line, data: line, empty line, empty line (terminator)
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("id: 1");
      expect(lines[1]).toBe("event: token");
      expect(lines[2]).toMatch(/^data: /);
    });
  });

  describe("emitSync", () => {
    it("sends event to controller with provided ID", () => {
      dispatcher.wire(mock.controller, mock.encoder);
      dispatcher.emitSync("token", { text: "hello" }, 5);

      expect(mock.controller.enqueue).toHaveBeenCalledTimes(1);
      const output = decodeChunks(mock.chunks);
      expect(output).toContain("id: 5");
      expect(output).toContain("event: token");
      expect(output).toContain('{"text":"hello"}');
    });

    it("skips when not wired", () => {
      dispatcher.emitSync("token", { text: "hello" }, 5);
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });

    it("skips when closed", () => {
      dispatcher.wire(mock.controller, mock.encoder);
      dispatcher.close();
      dispatcher.emitSync("token", { text: "hello" }, 5);
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });

    it("handles controller enqueue failure gracefully", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mock.enqueueMock.mockImplementationOnce(() => {
        throw new Error("Controller error");
      });
      dispatcher.wire(mock.controller, mock.encoder);

      dispatcher.emitSync("token", { text: "hello" }, 5);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to enqueue buffered SSE event"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("close", () => {
    it("sets closed flag", () => {
      expect(dispatcher.isClosed).toBe(false);
      dispatcher.close();
      expect(dispatcher.isClosed).toBe(true);
    });

    it("prevents further emits", async () => {
      mockBufferEvent.mockResolvedValueOnce(1);
      dispatcher.wire(mock.controller, mock.encoder);
      dispatcher.close();

      await dispatcher.emit("token", { text: "hello" });

      // Buffer is still called (source of truth)
      expect(mockBufferEvent).toHaveBeenCalledTimes(1);
      // But controller doesn't receive it
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });

    it("prevents further emitSync", () => {
      dispatcher.wire(mock.controller, mock.encoder);
      dispatcher.close();
      dispatcher.emitSync("token", { text: "hello" }, 1);
      expect(mock.controller.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("closes dispatcher and clears Redis buffer", async () => {
      dispatcher.wire(mock.controller, mock.encoder);
      await dispatcher.cleanup();

      expect(dispatcher.isClosed).toBe(true);
      expect(mockClearBuffer).toHaveBeenCalledWith("session-1");
    });

    it("is safe to call multiple times", async () => {
      dispatcher.wire(mock.controller, mock.encoder);
      await dispatcher.cleanup();
      await dispatcher.cleanup();

      expect(mockClearBuffer).toHaveBeenCalledTimes(2);
    });
  });

  describe("isClosed", () => {
    it("returns false initially", () => {
      expect(dispatcher.isClosed).toBe(false);
    });

    it("returns true after close", () => {
      dispatcher.close();
      expect(dispatcher.isClosed).toBe(true);
    });

    it("returns true after cleanup", async () => {
      await dispatcher.cleanup();
      expect(dispatcher.isClosed).toBe(true);
    });
  });
});

// ─── SSE Event Format ───────────────────────────────────────────────────────

describe("SSE event format", () => {
  let dispatcher: SseDispatcher;
  let mock: ReturnType<typeof createMockController>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBufferEvent.mockResolvedValue(1);
    dispatcher = new SseDispatcher("session-1");
    mock = createMockController();
    dispatcher.wire(mock.controller, mock.encoder);
  });

  it("includes id: field before event: field", async () => {
    mockBufferEvent.mockResolvedValueOnce(1);
    await dispatcher.emit("done", {});

    const output = decodeChunks(mock.chunks);
    const lines = output.split("\n");
    expect(lines[0]).toBe("id: 1");
    expect(lines[1]).toBe("event: done");
    expect(lines[2]).toBe("data: {}");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("");
  });

  it("produces valid SSE format for complex data", async () => {
    mockBufferEvent.mockResolvedValueOnce(2);
    await dispatcher.emit("tool_start", {
      toolCallId: "tc-1",
      toolName: "search",
      args: { query: "test" },
    });

    const output = decodeChunks(mock.chunks);
    const lines = output.split("\n");
    expect(lines[0]).toBe("id: 2");
    expect(lines[1]).toBe("event: tool_start");
    expect(lines[2]).toMatch(/^data: /);

    // Parse the data line
    const dataJson = lines[2]!.slice("data: ".length);
    const parsed = JSON.parse(dataJson);
    expect(parsed).toEqual({
      toolCallId: "tc-1",
      toolName: "search",
      args: { query: "test" },
    });
  });

  it("escapes newlines in data payload", async () => {
    mockBufferEvent.mockResolvedValueOnce(1);
    await dispatcher.emit("token", { text: "line1\nline2" });

    const output = decodeChunks(mock.chunks);
    // Should be a single data line (no literal newlines in the data)
    const lines = output.split("\n");
    expect(lines).toHaveLength(5); // id, event, data, empty, empty
    expect(lines[2]!.startsWith("data: ")).toBe(true);

    // The data should be valid JSON when parsed
    const dataJson = lines[2]!.slice("data: ".length);
    const parsed = JSON.parse(dataJson);
    expect(parsed.text).toBe("line1\nline2");
  });

  it("escapes carriage returns in data payload", async () => {
    mockBufferEvent.mockResolvedValueOnce(1);
    await dispatcher.emit("token", { text: "line1\r\nline2" });

    const output = decodeChunks(mock.chunks);
    const lines = output.split("\n");
    expect(lines).toHaveLength(5);

    const dataJson = lines[2]!.slice("data: ".length);
    const parsed = JSON.parse(dataJson);
    expect(parsed.text).toBe("line1\r\nline2");
  });

  it("handles null data", async () => {
    mockBufferEvent.mockResolvedValueOnce(1);
    await dispatcher.emit("ping", null);

    const output = decodeChunks(mock.chunks);
    expect(output).toContain("data: null");
  });

  it("handles arrays", async () => {
    mockBufferEvent.mockResolvedValueOnce(1);
    await dispatcher.emit("list", [1, 2, 3]);

    const output = decodeChunks(mock.chunks);
    expect(output).toContain("data: [1,2,3]");
  });
});

// ─── Reconnect scenarios ────────────────────────────────────────────────────

describe("reconnect scenarios", () => {
  let dispatcher: SseDispatcher;
  let mock: ReturnType<typeof createMockController>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBufferEvent.mockResolvedValue(1);
    mockClearBuffer.mockResolvedValue(undefined);
    dispatcher = new SseDispatcher("session-1");
    mock = createMockController();
  });

  it("dispatcher survives client disconnect and new connect", async () => {
    const oldMock = createMockController();
    const newMock = createMockController();

    dispatcher.wire(oldMock.controller, oldMock.encoder);

    // Emit some events on old connection
    mockBufferEvent.mockResolvedValue(1);
    await dispatcher.emit("token", { text: "hello" });
    expect(oldMock.controller.enqueue).toHaveBeenCalledTimes(1);

    // Client disconnects — dispatcher is closed
    dispatcher.close();

    // New client connects — rewire
    dispatcher.wire(newMock.controller, newMock.encoder);

    // New events go to new connection
    mockBufferEvent.mockResolvedValue(2);
    await dispatcher.emit("token", { text: "world" });
    expect(newMock.controller.enqueue).toHaveBeenCalledTimes(1);

    // Old connection should not receive new events
    expect(oldMock.controller.enqueue).toHaveBeenCalledTimes(1);
  });

  it("buffered replay with emitSync", async () => {
    dispatcher.wire(mock.controller, mock.encoder);

    // Simulate replaying buffered events from Redis
    dispatcher.emitSync("token", { text: "first" }, 1);
    dispatcher.emitSync("thinking", { thinking: "reasoning" }, 2);
    dispatcher.emitSync("token", { text: "second" }, 3);

    expect(mock.controller.enqueue).toHaveBeenCalledTimes(3);
    const output = decodeChunks(mock.chunks);
    expect(output).toContain("id: 1");
    expect(output).toContain("id: 2");
    expect(output).toContain("id: 3");
  });
});
