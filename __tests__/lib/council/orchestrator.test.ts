import { describe, expect, it } from "vitest";
import {
  runCouncilLoop,
  type CouncilRunPlan,
  type CouncilRunStore,
  type TurnRecord,
} from "@/lib/council/orchestrator";
import { createCouncilTools, type StopVoteKind } from "@/lib/council/tools";
import type { RoomMessageView } from "@/lib/council/room";
import type { CouncilMemberPlan } from "@/lib/council/orchestrator";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── A fake room ─────────────────────────────────────────────────────────────

class FakeRoom {
  messages: RoomMessageView[] = [];
  turns: Array<{
    memberId: string;
    memberName: string;
    triggeredBy: number[];
    record: TurnRecord;
  }> = [];
  progress: Array<Record<string, number>> = [];
  private seq = 0;

  readonly store: CouncilRunStore = {
    postMessage: async (input) => {
      const message: RoomMessageView = {
        seq: (this.seq += 1),
        memberId: input.memberId ?? null,
        authorName: input.authorName,
        authorKind: input.authorKind,
        content: input.content,
        addressedNames: input.mentions,
      };
      this.messages.push(message);
      return message;
    },

    messageWindow: async ({ afterSeq, limit }) => {
      const after = this.messages.filter((message) => message.seq > afterSeq);
      const newest = after.slice(-limit);
      return { messages: newest, skippedBefore: after.length - newest.length };
    },

    messagesAfter: async ({ afterSeq, limit, memberId }) =>
      this.messages
        .filter((message) => message.seq > afterSeq)
        .filter((message) => !memberId || message.memberId === memberId)
        .slice(-limit),

    startTurn: async (input) => {
      this.turns.push({
        memberId: input.memberId,
        memberName: input.memberName,
        triggeredBy: input.triggeredBy,
        record: {} as TurnRecord,
      });
      return String(this.turns.length);
    },

    finishTurn: async (turnId, data) => {
      this.turns[Number(turnId) - 1]!.record = data;
    },

    progress: async (totals) => {
      this.progress.push({ ...totals });
    },
  };

  messagesFrom(name: string) {
    return this.messages.filter((message) => message.authorName === name);
  }

  turnOf(name: string) {
    return this.turns.find((turn) => turn.memberName === name);
  }
}

// ─── A fake member session ───────────────────────────────────────────────────

interface TurnContext {
  prompt: string;
  post(content: string): Promise<{ seq: number; woke: string[] }>;
  vote(
    reason: string,
    kind: StopVoteKind,
  ): Promise<{ votes: number; needed: number; stopped: boolean }>;
  read(input?: { sinceSeq?: number; limit?: number }): Promise<RoomMessageView[]>;
}

type Behaviour = (turn: TurnContext) => void | Promise<void>;

class FakeAgentSession {
  listeners = new Set<(event: any) => void>();
  stats = { inputTokens: 0, outputTokens: 0, cost: 0 };
  aborted = false;
  disposed = false;
  prompts: string[] = [];
  /** Called when the run aborts this member's turn (a real abort ends it). */
  onAbort?: () => void;

  subscribe(cb: (event: any) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: any) {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string) {
    this.prompts.push(text);
    return this.onPrompt?.(text);
  }

  onPrompt?: (text: string) => unknown;

  /** Set to make the post-turn stats read fail, as a broken session would. */
  statsError = false;

  async abort() {
    this.aborted = true;
    this.onAbort?.();
  }

  getSessionStats() {
    if (this.statsError) throw new Error("the session cannot report its usage");
    return {
      tokens: { input: this.stats.inputTokens, output: this.stats.outputTokens },
      cost: this.stats.cost,
    };
  }

  dispose() {
    this.disposed = true;
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const MEMBER = (id: string, name: string, enabled = true): CouncilMemberPlan => ({
  id,
  name,
  enabled,
  instructions: null,
  modelProvider: "test",
  modelName: "model",
  thinkingLevel: "default",
  toolConfig: null,
});

function harness(options: {
  members: CouncilMemberPlan[];
  behaviours: Record<string, Behaviour>;
  openingMemberIds?: string[] | null;
  orchestration?: "parallel" | "round-robin";
  stopVoteThreshold?: "majority" | "unanimous" | "any";
  budget?: Partial<CouncilRunPlan["budget"]>;
  abortAfter?: (turnCount: number) => boolean;
  /** Make the loop's abort check fail, as an unreachable Redis would. */
  abortCheckFails?: (turnCount: number) => boolean;
}) {
  const room = new FakeRoom();
  const events: Array<{ event: string; data: any }> = [];
  const sessions = new Map<string, FakeAgentSession>();
  let turnsSeen = 0;

  const plan: CouncilRunPlan = {
    councilId: "council-1",
    userId: "user-1",
    runId: "run-1",
    councilName: "Launch review",
    brief: "Decide whether the migration is safe.",
    orchestration: options.orchestration ?? "parallel",
    stopVoteThreshold: options.stopVoteThreshold ?? "majority",
    budget: {
      maxDurationSeconds: null,
      maxTokens: null,
      maxCostUsd: null,
      ...options.budget,
    },
    toolConfig: { terminal: true },
    toolExposure: null,
    sandboxKey: "abcd1234",
    members: options.members,
    openingMemberIds: options.openingMemberIds ?? null,
    startedAfterSeq: 0,
  };

  const deps = {
    store: room.store,
    createSession: (async (sessionOptions: any) => {
      const memberId = sessionOptions.member.id as string;
      const session = new FakeAgentSession();
      sessions.set(memberId, session);

      // The member's real tools, driven by the scripted behaviour — so mentions,
      // wakes and votes travel the same path the model's calls do.
      const tools = createCouncilTools(sessionOptions.toolContext);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const execute = (name: string, params: Record<string, unknown>) =>
        (byName.get(name) as any).execute("call-1", params, undefined, undefined, {} as never);

      const behaviour = options.behaviours[memberId]!;
      session.onPrompt = async (text: string) => {
        turnsSeen += 1;
        const context: TurnContext = {
          prompt: text,
          post: async (content) => (await execute("council_post", { content })).structuredContent,
          vote: async (reason, kind) =>
            (await execute("council_vote_stop", { reason, kind })).structuredContent,
          read: async (input = {}) =>
            (await execute("council_read", input)).structuredContent.messages,
        };
        session.emit({ type: "message_update", message: { role: "assistant", content: [] } });
        await behaviour(context);
        // A completed turn, as Pi reports one.
        session.emit({
          type: "agent_end",
          willRetry: false,
          messages: [
            { role: "assistant", content: [{ type: "text", text: `final text from ${memberId}` }] },
          ],
        });
      };

      return { session, sandbox: { home: "/home/fake" }, modelLabel: "test:model" };
    }) as any,
    publish: async (event: string, data: unknown) => {
      events.push({ event, data });
    },
    now: () => Date.now(),
    isAbortRequested: async () => {
      if (options.abortCheckFails?.(turnsSeen)) throw new Error("redis is unreachable");
      return options.abortAfter?.(turnsSeen) ?? false;
    },
  };

  return { room, events, sessions, plan, deps, run: () => runCouncilLoop(plan, deps) };
}

const eventsOf = (events: Array<{ event: string; data: any }>, name: string) =>
  events.filter((entry) => entry.event === name);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runCouncilLoop — parallel", () => {
  it("wakes the member a post addresses, and ends when the owner is addressed", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async (turn) => {
          await turn.post("@blade the plan is in plan.md");
        },
        b: async (turn) => {
          await turn.post("@user the plan looks safe to me");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("user-question");
    expect(outcome.awaitingUser).toBe(true);
    expect(h.room.messages.map((m) => m.authorName)).toEqual(["acorn", "blade"]);
    // blade ran *because* acorn addressed it.
    expect(h.room.turnOf("blade")!.triggeredBy).toEqual([1]);
    expect(h.room.messages[0]!.addressedNames).toEqual(["blade"]);
  });

  it("wakes every member for @all, except the author", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async (turn) => {
          const posted = await turn.post("@all everyone check in");
          expect(posted.woke).toEqual(["blade", "cobalt"]);
        },
        // blade and cobalt each report in and address nobody: the room then
        // goes quiet, which is how the run ends.
        b: async (turn) => {
          await turn.post("blade here");
        },
        c: async (turn) => {
          await turn.post("cobalt here");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    expect(h.room.messagesFrom("blade")).toHaveLength(1);
    expect(h.room.messagesFrom("cobalt")).toHaveLength(1);
  });

  it("does not wake a member with its own mention, so it cannot loop itself", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async (turn) => {
          const posted = await turn.post("@acorn note to self");
          expect(posted.woke).toEqual([]);
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    expect(h.room.messagesFrom("acorn")).toHaveLength(1);
  });

  it("leaves disabled members out entirely", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade", false)],
      openingMemberIds: null,
      behaviours: {
        a: async (turn) => {
          const posted = await turn.post("@all anyone?");
          expect(posted.woke).toEqual([]);
        },
        b: async () => {
          throw new Error("a disabled member must never take a turn");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-pending-work");
    expect(h.sessions.has("b")).toBe(false);
  });

  it("ends a run with nothing left to do", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: null,
      behaviours: {
        a: async () => {},
        b: async () => {},
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-pending-work");
    expect(outcome.turnCount).toBe(2);
  });

  it("ends on a stop vote once the quorum is reached, before a woken member runs", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      // Only the two voters start; cobalt is woken by acorn's mention mid-turn.
      openingMemberIds: ["a", "b"],
      stopVoteThreshold: "majority",
      behaviours: {
        a: async (turn) => {
          await turn.vote("The plan is written.", "consensus");
          await turn.post("@cobalt please confirm before we close");
        },
        b: async (turn) => {
          await turn.vote("Agreed.", "consensus");
        },
        c: async () => {
          throw new Error("the run must stop before the third member speaks");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("consensus");
    // Quorum reached while cobalt sat in the inbox it was just woken into.
    expect(h.sessions.has("c")).toBe(false);
    const notices = h.room.messages.filter((m) => m.authorKind === "system").map((m) => m.content);
    expect(notices.some((text) => text.includes("acorn votes to stop (consensus)"))).toBe(true);
    expect(notices.some((text) => text.includes("blade votes to stop"))).toBe(true);
    expect(notices.some((text) => text.includes("2 of 2 required votes"))).toBe(true);
  });

  it("keeps going when a vote is short of the quorum", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      openingMemberIds: null,
      stopVoteThreshold: "unanimous",
      behaviours: {
        a: async (turn) => {
          await turn.vote("I am done.", "done");
        },
        b: async (turn) => {
          await turn.vote("Not yet.", "blocked");
        },
        c: async () => {},
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-pending-work");
  });

  it("counts a member's vote once, however often it votes", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      // Only acorn starts, so blade never runs: the first vote already met the quorum.
      openingMemberIds: ["a"],
      stopVoteThreshold: "any",
      behaviours: {
        a: async (turn) => {
          const first = await turn.vote("First.", "done");
          const second = await turn.vote("Second.", "done");
          expect(first).toMatchObject({ votes: 1, needed: 1, stopped: true });
          // A second vote from the same member does not count twice.
          expect(second).toMatchObject({ votes: 1, stopped: true });
        },
        b: async () => {
          throw new Error("the run must stop before blade speaks");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("consensus");
    expect(h.sessions.has("b")).toBe(false);
  });
});

describe("runCouncilLoop — budgets", () => {
  it("stops on a token budget once a turn has been paid for", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      budget: { maxTokens: 10 },
      behaviours: {
        a: async (turn) => {
          h.sessions.get("a")!.stats = { inputTokens: 100, outputTokens: 50, cost: 0.01 };
          await turn.post("@blade over to you");
        },
        b: async () => {},
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("budget:tokens");
    expect(outcome.inputTokens).toBe(100);
    // The member that was woken never ran: the budget was reached first.
    expect(h.sessions.has("b")).toBe(false);
  });

  it("stops on a cost budget", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      budget: { maxCostUsd: 0.5 },
      behaviours: {
        a: async () => {
          h.sessions.get("a")!.stats = { inputTokens: 0, outputTokens: 0, cost: 0.75 };
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("budget:cost");
    expect(outcome.cost).toBeCloseTo(0.75);
  });

  it("aborts a turn that runs past the wall-clock budget", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      budget: { maxDurationSeconds: 0.05 },
      behaviours: {
        a: () =>
          new Promise<void>((resolve) => {
            // A turn that only ends when the run aborts it.
            h.sessions.get("a")!.onAbort = resolve;
          }),
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("budget:time");
    expect(h.sessions.get("a")!.aborted).toBe(true);
  });

  it("applies no ceiling when the budget is null", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      budget: { maxTokens: null, maxCostUsd: null, maxDurationSeconds: null },
      behaviours: {
        a: async () => {
          h.sessions.get("a")!.stats = {
            inputTokens: 10_000_000,
            outputTokens: 10_000_000,
            cost: 999,
          };
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-pending-work");
  });
});

describe("runCouncilLoop — stopping early", () => {
  it("stops before the first turn when an abort has been requested", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      abortAfter: () => true,
      behaviours: {
        a: async () => {
          throw new Error("no turn should run");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("aborted");
    expect(outcome.turnCount).toBe(0);
  });

  it("stops mid-run when the owner aborts", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      // Abort once the first turn has run, i.e. before blade is picked up.
      abortAfter: (turns) => turns >= 1,
      behaviours: {
        a: async (turn) => {
          await turn.post("@blade your turn");
        },
        b: async () => {
          throw new Error("no turn should run after the abort");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("aborted");
    expect(h.sessions.has("b")).toBe(false);
  });

  it("keeps working when the stop check itself fails", async () => {
    // Redis being unreachable must not end the run: the loop re-checks later,
    // and the turn in flight has its own tolerant poll.
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      abortCheckFails: (turns) => turns === 1,
      behaviours: {
        a: async (turn) => {
          await turn.post("@blade your turn");
        },
        b: async (turn) => {
          await turn.post("blade: on it");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    expect(h.room.messagesFrom("blade")).toHaveLength(1);
  });

  it("reports a run with no enabled members instead of looping forever", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn", false)],
      openingMemberIds: null,
      behaviours: {},
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-members");
    expect(h.room.messagesFrom("council")).toHaveLength(1);
  });

  it("keeps the run alive when one member fails", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: null,
      behaviours: {
        a: async () => {
          throw new Error("provider exploded");
        },
        b: async (turn) => {
          await turn.post("blade here anyway");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    const failed = h.room.turnOf("acorn")!.record;
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("provider exploded");
    expect(h.room.messagesFrom("blade")).toHaveLength(1);
    // The room is told, so a silent failure cannot read as an idle member.
    expect(h.room.messages.some((m) => m.content.includes("acorn could not finish its turn"))).toBe(
      true,
    );
  });
});

describe("runCouncilLoop — preemption of an addressed member (parallel mode)", () => {
  it("ends a turn at the next tool boundary when the member is addressed, and re-runs it addressed", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a", "b"],
      behaviours: {
        a: async (turn) => {
          const session = h.sessions.get("a")!;
          if (session.prompts.length === 1) {
            // The first turn: a tool call is running when blade addresses it.
            session.emit({
              type: "message_update",
              message: {
                role: "assistant",
                content: [{ type: "thinking", thinking: "checking the plan" }],
              },
            });
            session.emit({
              type: "tool_execution_start",
              toolCallId: "t1",
              toolName: "read",
              args: { path: "plan.md" },
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            // The boundary: the turn must end here rather than run to its conclusion.
            session.emit({
              type: "tool_execution_end",
              toolCallId: "t1",
              result: { content: [{ type: "text", text: "plan" }] },
              isError: false,
            });
          } else {
            // The re-run turn answers the address.
            await turn.post("acorn: switching to plan2.md");
          }
        },
        b: async (turn) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          await turn.post("@acorn quick one — the plan moved to plan2.md");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    expect(outcome.turnCount).toBe(3);
    expect(h.sessions.get("a")!.aborted).toBe(true);

    const acornTurns = h.room.turns.filter((turn) => turn.memberName === "acorn");
    expect(acornTurns).toHaveLength(2);
    // The first turn ended at the boundary on purpose — not an error.
    expect(acornTurns[0]!.record.status).toBe("preempted");
    expect(acornTurns[0]!.record.error).toBeNull();
    // Its partial transcript is kept on the turn.
    expect(acornTurns[0]!.record.thinking).toContain("checking the plan");
    expect(acornTurns[1]!.record.status).toBe("completed");

    // The re-run was woken by blade's message and prompted as addressed.
    const bladeMessage = h.room.messages.find((m) => m.authorName === "blade")!;
    expect(acornTurns[1]!.triggeredBy).toEqual([bladeMessage.seq]);
    expect(h.sessions.get("a")!.prompts[1]!).toContain("You were addressed");
    expect(h.sessions.get("a")!.prompts[1]!).toContain("plan2.md");
    // No failure notice: the room never saw a failed turn.
    expect(h.room.messages.some((m) => m.content.includes("could not finish its turn"))).toBe(
      false,
    );
  });

  it("collects every message that landed while the turn ran into the one re-run turn", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      openingMemberIds: ["a", "b", "c"],
      behaviours: {
        a: async (turn) => {
          const session = h.sessions.get("a")!;
          if (session.prompts.length === 1) {
            session.emit({
              type: "tool_execution_start",
              toolCallId: "t1",
              toolName: "read",
              args: {},
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            session.emit({
              type: "tool_execution_end",
              toolCallId: "t1",
              result: { content: [{ type: "text", text: "ok" }] },
              isError: false,
            });
          } else {
            await turn.post("acorn: got both");
          }
        },
        b: async (turn) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await turn.post("@acorn first thing");
        },
        c: async (turn) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await turn.post("@acorn second thing");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.turnCount).toBe(4); // a ×2, b, c
    const acornTurns = h.room.turns.filter((turn) => turn.memberName === "acorn");
    expect(acornTurns).toHaveLength(2);
    expect(acornTurns[0]!.record.status).toBe("preempted");
    // Both messages woke the re-run, in order.
    const firstSeq = h.room.messages.find((m) => m.content === "@acorn first thing")!.seq;
    const secondSeq = h.room.messages.find((m) => m.content === "@acorn second thing")!.seq;
    expect(acornTurns[1]!.triggeredBy).toEqual([firstSeq, secondSeq]);
  });

  it("lets a turn without tool boundaries finish on its own before re-running it", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a", "b"],
      behaviours: {
        a: async (turn) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          await turn.post("@blade over to you");
        },
        b: async () => {
          // A long turn with no tool call: nothing to preempt it on.
          await new Promise((resolve) => setTimeout(resolve, 40));
        },
      },
    });

    const outcome = await h.run();

    expect(h.sessions.get("b")!.aborted).toBe(false);
    const bladeTurns = h.room.turns.filter((turn) => turn.memberName === "blade");
    expect(bladeTurns).toHaveLength(2);
    expect(bladeTurns[0]!.record.status).toBe("completed");
    expect(bladeTurns[1]!.record.status).toBe("completed");
    expect(outcome.turnCount).toBe(3);
  });
});

describe("runCouncilLoop — the owner speaking mid-run", () => {
  it("wakes the member the owner addressed while the room was working", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async () => {
          // The owner types into the room while acorn's turn runs.
          await h.room.store.postMessage({
            authorKind: "user",
            authorName: "Ada",
            content: "@blade take this one",
            mentions: ["blade"],
          });
        },
        b: async (turn) => {
          await turn.post("blade: on it");
        },
      },
    });

    const outcome = await h.run();

    expect(h.room.messagesFrom("blade")).toHaveLength(1);
    expect(outcome.turnCount).toBe(2);
    // The owner's message is in the inbox the turn recorded, so the subpage can
    // show what prompted it.
    expect(h.room.turnOf("blade")!.triggeredBy).toHaveLength(1);
  });

  it("wakes the whole room for an owner message that addresses nobody", async () => {
    let acornTurns = 0;
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async (turn) => {
          acornTurns += 1;
          await turn.post(`acorn: take ${acornTurns}`);
          if (acornTurns === 1) {
            await h.room.store.postMessage({
              authorKind: "user",
              authorName: "Ada",
              content: "what do you both think?",
              mentions: [],
            });
          }
        },
        b: async (turn) => {
          await turn.post("blade: here is my take");
        },
      },
    });

    const outcome = await h.run();

    // Addressed to nobody, so the owner is talking to the room: both members run.
    expect(h.room.messagesFrom("blade")).toHaveLength(1);
    expect(outcome.turnCount).toBe(3);
  });

  it("leaves the room quiet for a system notice", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async () => {
          await h.room.store.postMessage({
            authorKind: "system",
            authorName: "council",
            content: "nothing to see here",
            mentions: [],
          });
        },
        b: async () => {
          throw new Error("a notice must not wake anyone");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("no-pending-work");
    expect(h.sessions.has("b")).toBe(false);
  });
});

describe("runCouncilLoop — round-robin", () => {
  it("runs members in order, round after round, until a round is silent", async () => {
    const order: string[] = [];
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      orchestration: "round-robin",
      behaviours: {
        a: async (turn) => {
          order.push("acorn");
          // Speak in round 1 only.
          if (turn.prompt.includes("round 1")) await turn.post("acorn: opening take");
        },
        b: async (turn) => {
          order.push("blade");
          if (turn.prompt.includes("round 1")) await turn.post("blade: opening take");
        },
        c: async (turn) => {
          order.push("cobalt");
          if (turn.prompt.includes("round 1")) await turn.post("cobalt: opening take");
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.stopReason).toBe("no-pending-work");
    // Round 1 posts, round 2 is silent — so each member takes exactly two turns.
    expect(order).toEqual(["acorn", "blade", "cobalt", "acorn", "blade", "cobalt"]);
    expect(outcome.turnCount).toBe(6);
    expect(h.room.messagesFrom("acorn")).toHaveLength(1);
  });

  it("stops on a vote between turns, without waiting for the round to finish", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade"), MEMBER("c", "cobalt")],
      orchestration: "round-robin",
      stopVoteThreshold: "any",
      behaviours: {
        a: async (turn) => {
          await turn.vote("Nothing left to do.", "done");
        },
        b: async () => {
          throw new Error("the run must stop before blade's turn");
        },
        c: async () => {
          throw new Error("the run must stop before cobalt's turn");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.stopReason).toBe("consensus");
    expect(outcome.turnCount).toBe(1);
    expect(h.sessions.size).toBe(1);
  });

  it("tells each member which round it is, and shows what it missed", async () => {
    const prompts: Record<string, string[]> = { a: [], b: [] };
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      orchestration: "round-robin",
      behaviours: {
        a: async (turn) => {
          prompts.a!.push(turn.prompt);
          // Speak once, so the second round is silent and the run ends.
          if (turn.prompt.includes("round 1")) await turn.post("acorn: first");
        },
        b: async (turn) => {
          prompts.b!.push(turn.prompt);
        },
      },
    });

    await h.run();

    expect(prompts.a![0]).toContain("your turn in round 1");
    // Blade's first turn shows the message acorn posted moments earlier.
    expect(prompts.b![0]).toContain("acorn: first");
    expect(prompts.b![1]).toContain("your turn in round 2");
    // Nothing new was posted between blade's two turns.
    expect(prompts.b![1]).toContain("(nothing new)");
  });
});

describe("runCouncilLoop — the record it keeps", () => {
  it("records each turn's prompt inputs, transcript and cost", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      behaviours: {
        a: async (turn) => {
          // The member's session reports usage for its turn.
          h.sessions.get("a")!.stats = { inputTokens: 120, outputTokens: 30, cost: 0.02 };
          await turn.post("acorn: hello room");
        },
      },
    });

    await h.run();

    const turn = h.room.turnOf("acorn")!;
    expect(turn.record.status).toBe("completed");
    expect(turn.record.finalText).toBe("final text from a");
    expect(turn.record.postedSeqs).toEqual([1]);
    expect(turn.record.inputTokens).toBe(120);
    expect(turn.record.outputTokens).toBe(30);
    expect(turn.record.cost).toBeCloseTo(0.02);
    // The turn recorded why it ran, so a subpage can show the inbox. Nothing
    // woke it but the opening, and the opening has no room seq to record.
    expect(turn.triggeredBy).toEqual([]);
  });

  it("reports the run's totals on every turn, not just that turn's delta", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a", "b"],
      behaviours: {
        a: async (turn) => {
          h.sessions.get("a")!.stats = { inputTokens: 10, outputTokens: 5, cost: 0.001 };
          await turn.post("acorn: first");
        },
        b: async (turn) => {
          h.sessions.get("b")!.stats = { inputTokens: 20, outputTokens: 8, cost: 0.002 };
          await turn.post("blade: first");
        },
      },
    });

    await h.run();

    const ended = eventsOf(h.events, "turn_ended");
    expect(ended).toHaveLength(2);
    // Each event carries the run's running totals, so a client that has already
    // accounted for an earlier turn converges instead of double counting.
    expect(ended.at(-1)!.data.totals).toMatchObject({
      inputTokens: 30,
      outputTokens: 13,
      turnCount: 2,
    });
  });

  it("does not count a session's whole usage again when one read fails", async () => {
    let turns = 0;
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      behaviours: {
        a: async (turn) => {
          turns += 1;
          const session = h.sessions.get("a")!;
          if (turns === 1) {
            session.stats = { inputTokens: 100, outputTokens: 0, cost: 0.01 };
            await turn.post("acorn: one");
          } else if (turns === 2) {
            session.stats = { inputTokens: 300, outputTokens: 0, cost: 0.03 };
            // The read after this turn fails: the baseline must survive it.
            session.statsError = true;
            await turn.post("acorn: two");
          } else {
            session.statsError = false;
            session.stats = { inputTokens: 350, outputTokens: 0, cost: 0.05 };
            await turn.post("acorn: done");
          }
          if (turns < 3) {
            // The owner keeps the room awake so acorn takes another turn; the
            // third turn wakes nobody, so the run ends.
            await h.room.store.postMessage({
              authorKind: "user",
              authorName: "Ada",
              content: "@acorn one more thing",
              mentions: ["acorn"],
            });
          }
        },
      },
    });

    const outcome = await h.run();

    expect(outcome.turnCount).toBe(3);
    // 100 counted, one read failed, then the cumulative 350 — never 100+350.
    expect(outcome.inputTokens).toBe(350);
    expect(outcome.cost).toBeCloseTo(0.05);
    expect(h.room.progress.at(-1)).toMatchObject({ inputTokens: 350, turnCount: 3 });
  });

  it("reports the room's totals as the run progresses", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      behaviours: {
        a: async (turn) => {
          h.sessions.get("a")!.stats = { inputTokens: 10, outputTokens: 5, cost: 0.001 };
          await turn.post("acorn: first");
        },
      },
    });

    await h.run();

    expect(h.room.progress.at(-1)).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      turnCount: 1,
    });
  });

  it("publishes turn lifecycle, messages and live thinking", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      behaviours: {
        a: async (turn) => {
          const session = h.sessions.get("a")!;
          session.emit({
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "weighing options" }],
            },
          });
          await turn.post("acorn: decided");
        },
      },
    });

    await h.run();

    expect(eventsOf(h.events, "turn_started")).toHaveLength(1);
    expect(eventsOf(h.events, "turn_ended")).toHaveLength(1);
    expect(eventsOf(h.events, "message")).toHaveLength(1);
    const thinking = eventsOf(h.events, "thinking");
    expect(thinking.at(-1)!.data.thinking).toBe("weighing options");
  });

  it("disposes every member session when the run ends", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: null,
      behaviours: { a: async () => {}, b: async () => {} },
    });

    await h.run();

    expect([...h.sessions.values()].every((session) => session.disposed)).toBe(true);
  });

  it("gives the member its workspace path and a real prompt", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn")],
      openingMemberIds: null,
      behaviours: { a: async () => {} },
    });

    await h.run();

    const prompt = h.sessions.get("a")!.prompts[0]!;
    expect(prompt).toContain("/home/fake");
    expect(prompt).toContain("council_post");
  });

  it("shows a member the room it missed, and says what was left out", async () => {
    const h = harness({
      members: [MEMBER("a", "acorn"), MEMBER("b", "blade")],
      openingMemberIds: ["a"],
      behaviours: {
        a: async (turn) => {
          await turn.post("@blade here is a very long message ".repeat(50));
        },
        b: async (turn) => {
          expect(turn.prompt).toContain("very long message");
          expect(turn.read).toBeTypeOf("function");
        },
      },
    });

    const outcome = await h.run();
    expect(outcome.turnCount).toBe(2);
  });
});
