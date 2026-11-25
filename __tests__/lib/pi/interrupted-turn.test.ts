import { describe, it, expect, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  answerOrphanedCalls,
  applyInterruptedTurn,
  INTERRUPTED_TOOL_RESULT,
  planInterruptedTurn,
} from "@/lib/pi/interrupted-turn";

/**
 * Reading a transcript a restart cut off.
 *
 * What the run may continue from is the whole question: a prompt that never ran,
 * a call whose result never arrived, and a turn the model finished all need a
 * different move, and picking the wrong one either loses the work or sends a
 * request the provider rejects.
 */

/** A transcript-only session: the plan and the pairing only touch these two. */
function makeSession(): AgentSession & { refreshContext: ReturnType<typeof vi.fn> } {
  const session = {
    sessionManager: SessionManager.inMemory(),
    refreshContext: vi.fn(),
  };
  return session as unknown as AgentSession & { refreshContext: ReturnType<typeof vi.fn> };
}

const USER = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "build it" }],
  timestamp: Date.now(),
};

/** An assistant turn, optionally asking for a tool. */
function assistantTurn(text: string, calls: { id: string; name: string }[] = []) {
  return {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "mock" as const,
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length > 0 ? ("toolUse" as const) : ("stop" as const),
    timestamp: Date.now(),
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: {},
      })),
    ],
  };
}

function toolResult(call: { id: string; name: string }) {
  return {
    role: "toolResult" as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text" as const, text: "done" }],
    isError: false,
    timestamp: Date.now(),
  };
}

const BASH = { id: "call-1", name: "bash" };

describe("planInterruptedTurn", () => {
  it("continues when the prompt never got a turn", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({
      kind: "continue",
      orphanedCalls: [],
    });
  });

  it("continues past a finished turn with its tool results", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("checking", [BASH]));
    session.sessionManager.appendMessage(toolResult(BASH));

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({
      kind: "continue",
      orphanedCalls: [],
    });
  });

  it("answers a call whose result never arrived", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("running it", [BASH]));

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({
      kind: "continue",
      orphanedCalls: [{ id: "call-1", name: "bash" }],
    });
  });

  it("answers only the calls of a batch that never returned", async () => {
    const session = makeSession();
    const read = { id: "call-2", name: "read" };
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("both", [BASH, read]));
    session.sessionManager.appendMessage(toolResult(BASH));

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({
      kind: "continue",
      orphanedCalls: [{ id: "call-2", name: "read" }],
    });
  });

  it("restarts a turn the model finished, which a new message may not follow", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("all done"));

    const plan = planInterruptedTurn(session, { content: "build it" });
    expect(plan.kind).toBe("restart");
  });

  it("reads through the state entries a session appends, like its model", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("all done"));
    // Building a session records the model and thinking level as entries of
    // their own, and they sit at the leaf.
    session.sessionManager.appendModelChange("mock", "test-model");
    session.sessionManager.appendThinkingLevelChange("off");

    expect(planInterruptedTurn(session, { content: "build it" }).kind).toBe("restart");
  });

  it("prompts when the transcript never received the message", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "something else" }],
      timestamp: Date.now(),
    });

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({ kind: "prompt" });
  });

  it("prompts when a later message took the conversation over", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("partial", [BASH]));
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "never mind, do this instead" }],
      timestamp: Date.now(),
    });

    expect(planInterruptedTurn(session, { content: "build it" })).toEqual({ kind: "prompt" });
  });
});

describe("applyInterruptedTurn", () => {
  it("appends the missing results and resyncs the agent's context", () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("running it", [BASH]));

    answerOrphanedCalls(session, [{ id: "call-1", name: "bash" }]);

    const branch = session.sessionManager.getBranch();
    const result = branch[branch.length - 1]!;
    expect(result.type).toBe("message");
    expect(result.type === "message" && result.message.role).toBe("toolResult");
    expect(JSON.stringify(result)).toContain(INTERRUPTED_TOOL_RESULT);
    expect(session.refreshContext).toHaveBeenCalled();
  });

  it("leaves the transcript alone for a call that already has its result", () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);
    session.sessionManager.appendMessage(assistantTurn("running it", [BASH]));
    session.sessionManager.appendMessage(toolResult(BASH));
    const before = session.sessionManager.getEntries().length;

    answerOrphanedCalls(session, []);

    expect(session.sessionManager.getEntries()).toHaveLength(before);
    expect(session.refreshContext).not.toHaveBeenCalled();
  });

  it("reports a continued turn, so the run does not send the message again", async () => {
    const session = makeSession();
    session.sessionManager.appendMessage(USER);

    const continued = await applyInterruptedTurn(session, { kind: "continue", orphanedCalls: [] });

    expect(continued).toBe(true);
  });
});
