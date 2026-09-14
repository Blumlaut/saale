import { describe, it, expect, vi } from "vitest";
import { drainSendQueue, type DrainDeps } from "@/lib/chat/drain-queue";
import type { QueuedChatMessage } from "@/lib/chat/serialize-message";

/**
 * Queued messages must be delivered exactly once, in order, without ever
 * stalling the queue or dropping a message — the cases below are the ones that
 * can go wrong when a run settles, a claim races another connection, or the
 * agent is already busy.
 */

function message(id: string, queuedAt = new Date("2026-01-01T00:00:00Z")): QueuedChatMessage {
  return {
    id,
    sessionId: "session-1",
    role: "user",
    content: `text of ${id}`,
    thinking: null,
    toolCalls: null,
    errorMessage: null,
    parentMessageId: null,
    createdAt: queuedAt,
    editedAt: null,
    queuedAt,
    attachments: [],
  };
}

function makeDeps(queue: QueuedChatMessage[]) {
  const pending = [...queue];
  const delivered: string[] = [];
  const restored: string[] = [];
  const deps: DrainDeps = {
    isPromptInFlight: vi.fn(() => false),
    claimNext: vi.fn(async () => pending.shift() ?? null),
    run: vi.fn(async (msg: QueuedChatMessage) => {
      delivered.push(msg.id);
      return true;
    }),
    restore: vi.fn(async (msg: QueuedChatMessage) => {
      restored.push(msg.id);
    }),
    publishQueue: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { deps, delivered, restored, pending };
}

describe("drainSendQueue", () => {
  it("delivers every queued message in order", async () => {
    const { deps, delivered } = makeDeps([message("msg-1"), message("msg-2"), message("msg-3")]);

    const count = await drainSendQueue(deps);

    expect(count).toBe(3);
    expect(delivered).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("stops without claiming anything while a run is already in flight", async () => {
    const { deps, pending } = makeDeps([message("msg-1")]);
    deps.isPromptInFlight = vi.fn(() => true);

    expect(await drainSendQueue(deps)).toBe(0);
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
  });

  it("stops after an idle queue", async () => {
    const { deps } = makeDeps([]);

    expect(await drainSendQueue(deps)).toBe(0);
    expect(deps.claimNext).toHaveBeenCalledTimes(1);
    expect(deps.publishQueue).not.toHaveBeenCalled();
  });

  it("requeues and stops when the message cannot be handed to the agent", async () => {
    const { deps, delivered, restored, pending } = makeDeps([message("msg-1"), message("msg-2")]);
    deps.run = vi.fn(async (msg: QueuedChatMessage) => {
      delivered.push(msg.id);
      return msg.id !== "msg-1";
    });

    const count = await drainSendQueue(deps);

    // msg-1 was claimed but never delivered, and msg-2 was never touched: it
    // stays in the queue for the next drain.
    expect(count).toBe(0);
    expect(delivered).toEqual(["msg-1"]);
    expect(restored).toEqual(["msg-1"]);
    expect(deps.publishQueue).toHaveBeenCalledTimes(1);
    expect(pending.map((m) => m.id)).toEqual(["msg-2"]);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("msg-1"));
  });

  it("counts a run that failed after delivery as delivered (no duplicate)", async () => {
    // A provider error inside the run is persisted by the caller, so the
    // message must not be requeued — the user would see it twice.
    const { deps, delivered, restored } = makeDeps([message("msg-1")]);
    deps.run = vi.fn(async (msg: QueuedChatMessage) => {
      delivered.push(msg.id);
      return true;
    });

    expect(await drainSendQueue(deps)).toBe(1);
    expect(restored).toEqual([]);
  });

  it("stops the loop when a prompt starts mid-drain", async () => {
    const { deps, pending } = makeDeps([message("msg-1"), message("msg-2")]);
    let inFlight = false;
    deps.isPromptInFlight = vi.fn(() => inFlight);
    deps.run = vi.fn(async (msg: QueuedChatMessage) => {
      // Simulate the delivered message starting a run that is still going
      // when the loop comes back around.
      inFlight = msg.id === "msg-1";
      return true;
    });

    expect(await drainSendQueue(deps)).toBe(1);
    expect(pending.map((m) => m.id)).toEqual(["msg-2"]);
  });
});
