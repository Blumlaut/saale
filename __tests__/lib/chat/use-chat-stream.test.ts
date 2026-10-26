import { describe, it, expect, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { wireStreamListeners } from "@/components/chat/use-chat-stream";
import type { ApprovalData, Message, PluginDialogData } from "@/components/chat/types";

/**
 * `tool_end` carries the tool name so the UI can react to specific tools —
 * the chat header refreshes its linked-watchers list the moment a watcher
 * tool finishes, without a navigation. These tests pin that wiring: the
 * callback fires with the right name and stays quiet when the payload has
 * no name (older buffered events).
 */

class FakeEventSource {
  listeners = new Map<string, EventListener[]>();
  onerror: ((event?: unknown) => void) | null = null;

  addEventListener(type: string, listener: EventListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown) {
    const payload = { data: typeof data === "string" ? data : JSON.stringify(data) };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload as unknown as Event);
    }
  }
}

function wire(onToolEnd?: (toolName: string) => void) {
  const eventSource = new FakeEventSource();
  const opts = {
    eventSource: eventSource as unknown as EventSource,
    rootMessageIdRef: { current: null },
    sessionId: "session-a",
    eventSourceRef: { current: eventSource } as unknown as { current: EventSource | null },
    setMessages: vi.fn(),
    setIsLoading: vi.fn(),
    setPendingApprovals: vi.fn() as Dispatch<SetStateAction<ApprovalData[]>>,
    setPluginDialogs: vi.fn() as Dispatch<SetStateAction<PluginDialogData[]>>,
    markDone: vi.fn(),
    onReload: vi.fn(),
    ...(onToolEnd ? { onToolEnd } : {}),
  };
  wireStreamListeners(opts);
  return { ...opts, eventSource };
}

describe("wireStreamListeners tool_end", () => {
  it("passes the tool name to onToolEnd when a tool call finishes", () => {
    const onToolEnd = vi.fn();
    const { eventSource } = wire(onToolEnd);

    eventSource.emit("tool_end", {
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "watcher_create",
      result: "ok",
    });

    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("watcher_create");
  });

  it("does not call onToolEnd when the payload has no tool name", () => {
    const onToolEnd = vi.fn();
    const { eventSource } = wire(onToolEnd);

    eventSource.emit("tool_end", {
      turnId: "turn-1",
      toolCallId: "call-1",
      result: "ok",
    });

    expect(onToolEnd).not.toHaveBeenCalled();
  });

  it("does not throw when onToolEnd is not provided", () => {
    const { eventSource } = wire();

    expect(() =>
      eventSource.emit("tool_end", {
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "watcher_delete",
        result: "ok",
      }),
    ).not.toThrow();
  });

  it("still updates messages when onToolEnd is provided", () => {
    const onToolEnd = vi.fn();
    const { eventSource, setMessages } = wire(onToolEnd);

    eventSource.emit("tool_end", {
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "watcher_update",
      result: "ok",
    });

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("watcher_update");
  });
});

describe("wireStreamListeners tool_pending", () => {
  it("renders a call the model is still writing arguments for", () => {
    const { eventSource, setMessages, setIsLoading } = wire();

    eventSource.emit("tool_pending", {
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git" },
    });

    // The turn is alive even though nothing is executing yet.
    expect(setIsLoading).toHaveBeenCalledWith(true);

    const update = setMessages.mock.calls[0]![0] as (prev: Message[]) => Message[];
    const messages = update([]);
    expect(messages[0]!.toolCalls).toEqual([
      { id: "call-1", name: "bash", args: { command: "git" }, status: "pending" },
    ]);
  });
});

/**
 * Message-state updates are coalesced per frame. A provider emits cumulative
 * token/thinking/tool-output events far faster than a screen refreshes, and a
 * render per event left the main thread with no frame to spare: scrolling the
 * transcript mid-run felt stuck.
 */
describe("wireStreamListeners coalescing", () => {
  /**
   * Resolve once the queued update has been applied. The runner has no
   * animation frames, so the batch flushes on its fallback timer.
   */
  const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  interface Row {
    id: string;
    content?: string;
    thinking?: string;
  }
  type Updater = (prev: Row[]) => Row[];

  function applyUpdaters(setMessages: ReturnType<typeof vi.fn>): Row[] {
    return setMessages.mock.calls.reduce(
      (messages: Row[], call) => (call[0] as Updater)(messages),
      [] as Row[],
    );
  }

  it("applies a burst of live events as one state update per frame", async () => {
    const { eventSource, setMessages } = wire();

    eventSource.emit("token", { turnId: "turn-1", text: "a" });
    eventSource.emit("token", { turnId: "turn-1", text: "ab" });
    eventSource.emit("thinking", { turnId: "turn-1", thinking: "hmm" });
    expect(setMessages).not.toHaveBeenCalled();

    await nextFrame();

    expect(setMessages).toHaveBeenCalledTimes(1);
    const [message] = applyUpdaters(setMessages);
    // Cumulative payloads: the newest text is the whole bubble.
    expect(message?.content).toBe("ab");
    expect(message?.thinking).toBe("hmm");
  });

  it("applies a structural event immediately, after what was queued before it", () => {
    const { eventSource, setMessages } = wire();

    eventSource.emit("token", { turnId: "turn-1", text: "half an ans" });
    eventSource.emit("turn_end", { turnId: "turn-1", text: "half an answer" });

    // No frame needed: the run moved on, so the pending token lands first.
    expect(setMessages).toHaveBeenCalledTimes(1);
    const [message] = applyUpdaters(setMessages);
    expect(message?.content).toBe("half an answer");
  });

  it("lands a queued token on the row the turn was just saved as", async () => {
    const { eventSource, setMessages } = wire();

    eventSource.emit("turn_start", { turnId: "turn-1" });
    eventSource.emit("message_saved", { turnId: "turn-1", messageId: "row-1" });
    // Queued after `message_saved` renamed the turn: the token must patch that
    // row rather than add a second bubble for the same turn.
    eventSource.emit("token", { turnId: "turn-1", text: "more" });
    await nextFrame();

    const messages = applyUpdaters(setMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("row-1");
    expect(messages[0]?.content).toBe("more");
  });
});
