import { describe, it, expect, vi } from "vitest";

/**
 * What the agent is actually told when a watcher fires.
 *
 * The message is the entire handover: the script's value is the only evidence
 * the agent has that anything happened, so it has to arrive intact and readable
 *  including for a value that is awkward to render.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/chat/respond-in-chat", () => ({ respondInChat: vi.fn() }));
vi.mock("@/lib/agent-jobs/run", () => ({ triggerAgentRun: vi.fn() }));

import { buildWakeMessage } from "@/lib/watchers/wake";

describe("buildWakeMessage", () => {
  it("names the watcher, carries the instructions and the script's value", () => {
    const message = buildWakeMessage({
      name: "Watch the inbox",
      wakePrompt: "Summarise what is new and archive it.",
      value: { count: 2, subjects: ["Invoice", "Deploy failed"] },
    });

    expect(message).toContain('Watcher "Watch the inbox" fired.');
    expect(message).toContain("Summarise what is new and archive it.");
    expect(message).toContain("```json");
    // The value is the evidence, so it is embedded as readable JSON.
    expect(message).toContain('"count": 2');
    expect(message).toContain('"Deploy failed"');
  });

  it("tells the agent when a script reports a bare signal rather than data", () => {
    const message = buildWakeMessage({
      name: "Watch a host",
      wakePrompt: "Check whether it needs attention.",
      value: true,
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
    });

    expect(message).toContain('Watcher "Watch a host" fired.');
    expect(message).toContain("Check it.");
    expect(message).toContain("[object Object]");
  });

  it("keeps an unbreakable value from escaping its code block", () => {
    const message = buildWakeMessage({
      name: "Watch a feed",
      wakePrompt: "Summarise it.",
      value: { url: `https://example.com/${"x".repeat(300)}` },
    });

    // Fenced, so a long single-token value wraps in the transcript instead of
    // running off it.
    expect(message.split("```json")).toHaveLength(2);
  });
});
