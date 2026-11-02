import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What the agent is actually told when an automation fires.
 *
 * The message is the entire handover: the script's value is the only evidence
 * the agent has that anything happened, so it has to arrive intact and readable
 *  including for a value that is awkward to render. An automation with no
 * script has no value to carry: it fires bare.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/chat/respond-in-chat", () => ({ respondInChat: vi.fn() }));
vi.mock("@/lib/coder/dispatch", () => ({ dispatchWatcherRun: vi.fn() }));
vi.mock("@/lib/watchers/standalone", () => ({ runStandaloneWake: vi.fn() }));

import { respondInChat } from "@/lib/chat/respond-in-chat";
import { dispatchWatcherRun } from "@/lib/coder/dispatch";
import { runStandaloneWake } from "@/lib/watchers/standalone";
import { buildWakeMessage, deliverWake, type WakeTarget } from "@/lib/watchers/wake";

function target(overrides: Partial<WakeTarget> = {}): WakeTarget {
  return {
    id: "w-1",
    userId: "u-1",
    name: "Watch the inbox",
    deliver: "chat",
    sessionId: "chat-1",
    originSessionId: null,
    projectId: null,
    worktreeMode: "per-fire",
    stickySessionId: null,
    wakePrompt: "Summarise it.",
    modelId: null,
    thinkingLevel: "off",
    ...overrides,
  };
}

describe("buildWakeMessage", () => {
  it("names the watcher, carries the instructions and the script's value", () => {
    const message = buildWakeMessage({
      name: "Watch the inbox",
      wakePrompt: "Summarise what is new and archive it.",
      value: { count: 2, subjects: ["Invoice", "Deploy failed"] },
      gated: true,
    });

    expect(message).toContain('Automation "Watch the inbox" fired.');
    expect(message).toContain("Summarise what is new and archive it.");
    expect(message).toContain("```json");
    // The value is the evidence, so it is embedded as readable JSON.
    expect(message).toContain('"count": 2');
    expect(message).toContain('"Deploy failed"');
  });

  it("carries the instructions alone when the automation has no gate", () => {
    const message = buildWakeMessage({
      name: "Morning digest",
      wakePrompt: "Write the digest and send it.",
      gated: false,
    });

    expect(message).toContain('Automation "Morning digest" fired.');
    expect(message).toContain("Write the digest and send it.");
    // Nothing was returned, so there is no evidence to quote.
    expect(message).not.toContain("The script returned");
  });

  it("tells the agent when a script reports a bare signal rather than data", () => {
    const message = buildWakeMessage({
      name: "Watch a host",
      wakePrompt: "Check whether it needs attention.",
      value: true,
      gated: true,
    });

    expect(message).toContain("true");
  });

  it("still produces a message when the value cannot be rendered as JSON", () => {
    // A sandbox value is JSON by construction, so this guards the runner's
    // contract rather than an expected input  the wake must not be lost to it.
    const circular: Record<string, unknown> = { host: "web-1" };
    circular.self = circular;

    const message = buildWakeMessage({
      name: "Watch a host",
      wakePrompt: "Check it.",
      value: circular,
      gated: true,
    });

    expect(message).toContain('Automation "Watch a host" fired.');
    expect(message).toContain("Check it.");
    expect(message).toContain("[object Object]");
  });

  it("keeps an unbreakable value from escaping its code block", () => {
    const message = buildWakeMessage({
      name: "Watch a feed",
      wakePrompt: "Summarise it.",
      value: { url: `https://example.com/${"x".repeat(300)}` },
      gated: true,
    });

    // Fenced, so a long single-token value wraps in the transcript instead of
    // running off it.
    expect(message.split("```json")).toHaveLength(2);
  });
});

describe("deliverWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(respondInChat).mockResolvedValue({
      sessionId: "chat-1",
      title: "Trip planning",
      reply: "done",
      answered: true,
      error: null,
    });
  });

  it("posts into the chosen conversation", async () => {
    const delivered = await deliverWake({ watcher: target(), value: { count: 2 }, gated: true });

    expect(delivered.sessionId).toBe("chat-1");
    expect(respondInChat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        sessionId: "chat-1",
        message: expect.stringContaining('Automation "Watch the inbox" fired.'),
      }),
    );
  });

  it("dispatches into the watcher's project", async () => {
    vi.mocked(dispatchWatcherRun).mockResolvedValue({ sessionId: "bot-chat" });

    const delivered = await deliverWake({
      watcher: target({ deliver: "coder", sessionId: null, projectId: "project-1" }),
      value: { issue: 14 },
      gated: true,
    });

    expect(delivered.sessionId).toBe("bot-chat");
    expect(dispatchWatcherRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        value: { issue: 14 },
        watcher: expect.objectContaining({ projectId: "project-1" }),
      }),
    );
    expect(respondInChat).not.toHaveBeenCalled();
  });

  it("runs a fire with no chat on its own and reports what it said", async () => {
    vi.mocked(runStandaloneWake).mockResolvedValue({
      answer: "Nothing new since yesterday.",
      toolNames: ["telegram_send"],
      inputTokens: 120,
      outputTokens: 30,
      cost: 0.001,
    });

    const delivered = await deliverWake({
      watcher: target({ deliver: "none", sessionId: null, originSessionId: "chat-9" }),
      value: undefined,
      gated: false,
    });

    expect(delivered).toEqual({
      sessionId: null,
      answer: "Nothing new since yesterday.",
      toolNames: ["telegram_send"],
      inputTokens: 120,
      outputTokens: 30,
      cost: 0.001,
    });
    // The tools act as the chat that asked for it, so a message it sends has
    // somewhere to belong.
    expect(runStandaloneWake).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "chat-9", message: expect.stringContaining("fired") }),
    );
    expect(respondInChat).not.toHaveBeenCalled();
  });

  it("wakes nobody for a silent watcher", async () => {
    const delivered = await deliverWake({
      watcher: target({ deliver: "silent" }),
      value: { sent: true },
      gated: true,
    });

    expect(delivered.sessionId).toBeNull();
    expect(respondInChat).not.toHaveBeenCalled();
    expect(dispatchWatcherRun).not.toHaveBeenCalled();
  });

  it("says what is missing rather than reporting nowhere", async () => {
    await expect(
      deliverWake({ watcher: target({ sessionId: null }), value: { count: 2 }, gated: true }),
    ).rejects.toThrow(/no conversation/);
  });

  it("surfaces a busy conversation so the tick can retry it", async () => {
    vi.mocked(respondInChat).mockRejectedValue(new Error('Chat "Trip planning" is busy'));

    await expect(
      deliverWake({ watcher: target(), value: { count: 2 }, gated: true }),
    ).rejects.toThrow(/busy/);
  });
});
