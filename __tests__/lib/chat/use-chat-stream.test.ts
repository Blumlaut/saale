import { describe, it, expect, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { wireStreamListeners } from "@/components/chat/use-chat-stream";
import type { ApprovalData, Message } from "@/components/chat/types";

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
