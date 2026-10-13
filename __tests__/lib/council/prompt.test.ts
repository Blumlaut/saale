import { describe, expect, it } from "vitest";
import {
  buildCouncilMemberPrompt,
  buildCouncilTurnPrompt,
  selectTurnMessages,
  type CouncilPromptContext,
  type TurnMessage,
} from "@/lib/council/prompt";
import { TRANSCRIPT_MAX_CHARS } from "@/lib/council/config";

const CONTEXT: CouncilPromptContext = {
  councilName: "Launch review",
  brief: "Decide whether the migration plan is safe to run this week.",
  member: { name: "acorn", instructions: "You own the database side." },
  members: [{ name: "acorn" }, { name: "blade" }, { name: "cobalt" }],
  orchestration: "parallel",
  stopVoteThreshold: "majority",
  stopVoteQuorum: 2,
  sandboxPath: "/home/uabcd1234",
};

describe("buildCouncilMemberPrompt", () => {
  it("names the member, the council and its goal", () => {
    const prompt = buildCouncilMemberPrompt(CONTEXT);
    expect(prompt).toContain("You are acorn");
    expect(prompt).toContain("Launch review");
    expect(prompt).toContain("Decide whether the migration plan is safe to run this week.");
  });

  it("includes the member's own role and nobody else's", () => {
    const prompt = buildCouncilMemberPrompt({
      ...CONTEXT,
      members: [
        { name: "acorn", instructions: "You own the database side." },
        { name: "blade", instructions: "SECRET: you are secretly the reviewer." },
      ],
    });
    expect(prompt).toContain("You own the database side.");
    // Another member's role is not part of this member's prompt.
    expect(prompt).not.toContain("SECRET");
  });

  it("lists the other members as handles, without listing the member itself", () => {
    const prompt = buildCouncilMemberPrompt(CONTEXT);
    expect(prompt).toContain("@blade");
    expect(prompt).toContain("@cobalt");
    expect(prompt).not.toContain("@acorn");
    expect(prompt).toContain("@user");
    expect(prompt).toContain("@all");
  });

  it("states that only a posted message is delivered", () => {
    const prompt = buildCouncilMemberPrompt(CONTEXT);
    expect(prompt).toContain("council_post");
    expect(prompt).toContain("closing text");
    expect(prompt).toMatch(/not\*\* shown to anyone|is\s+\*\*not\*\* shown/);
  });

  it("describes the workspace it was given", () => {
    expect(buildCouncilMemberPrompt(CONTEXT)).toContain("/home/uabcd1234");
    const withoutSandbox = buildCouncilMemberPrompt({ ...CONTEXT, sandboxPath: null });
    expect(withoutSandbox).not.toContain("/home/uabcd1234");
  });

  it("states the vote quorum for the council's threshold", () => {
    expect(buildCouncilMemberPrompt(CONTEXT)).toMatch(/2 of the members must vote to stop/);
    expect(
      buildCouncilMemberPrompt({ ...CONTEXT, stopVoteThreshold: "unanimous", stopVoteQuorum: 3 }),
    ).toMatch(/all 3 members must vote to stop/);
    expect(
      buildCouncilMemberPrompt({ ...CONTEXT, stopVoteThreshold: "any", stopVoteQuorum: 1 }),
    ).toMatch(/a single vote to stop ends the run/);
  });

  it("describes the turn model it is running under", () => {
    const parallel = buildCouncilMemberPrompt(CONTEXT);
    expect(parallel).toMatch(/You run when someone addresses you/);
    expect(parallel).toMatch(/at the same time as you/);

    const rounds = buildCouncilMemberPrompt({ ...CONTEXT, orchestration: "round-robin" });
    expect(rounds).toMatch(/one turn per round/);
    expect(rounds).toMatch(/every member speaks once per round/);
    expect(rounds).toMatch(/nobody posts anything ends the run/);
  });

  it("tells a waiting member to end its turn, in the terms of its mode", () => {
    // Holding a turn open for an answer is the instinct this rule counters, and
    // how the answer arrives depends on the mode.
    const parallel = buildCouncilMemberPrompt(CONTEXT);
    expect(parallel).toMatch(/waiting on another member's reply, end your turn/);
    expect(parallel).toMatch(/wakes you as soon as someone addresses you/);
    expect(parallel).toMatch(/Never hold a turn open/);

    const rounds = buildCouncilMemberPrompt({ ...CONTEXT, orchestration: "round-robin" });
    expect(rounds).toMatch(/waiting on another member's reply, end your turn/);
    expect(rounds).toMatch(/next round carries whatever they posted/);
    expect(rounds).not.toMatch(/wakes you as soon as someone addresses you/);
  });

  it("does not describe a role for a member that has none", () => {
    const prompt = buildCouncilMemberPrompt({ ...CONTEXT, member: { name: "acorn" } });
    expect(prompt).not.toContain("Your role in this council");
  });
});

const MESSAGE = (seq: number, overrides: Partial<TurnMessage> = {}): TurnMessage => ({
  seq,
  memberId: "m2",
  authorName: "blade",
  authorKind: "member",
  content: `message ${seq}`,
  addressedNames: [],
  ...overrides,
});

describe("selectTurnMessages", () => {
  it("keeps the newest messages inside the count window", () => {
    const messages = Array.from({ length: 10 }, (_, i) => MESSAGE(i + 1));
    const selection = selectTurnMessages(messages, 3);
    expect(selection.messages.map((m) => m.seq)).toEqual([8, 9, 10]);
    expect(selection.droppedEarlier).toBe(7);
  });

  it("caps by characters as well as by count, keeping the newest", () => {
    const messages = [
      MESSAGE(1, { content: "a".repeat(5000) }),
      MESSAGE(2, { content: "b".repeat(5000) }),
      MESSAGE(3, { content: "c".repeat(5000) }),
    ];
    const selection = selectTurnMessages(messages, 80, 12_000);
    expect(selection.messages.map((m) => m.seq)).toEqual([2, 3]);
    expect(selection.droppedEarlier).toBe(1);
  });

  it("always keeps one message, however long it is", () => {
    const selection = selectTurnMessages(
      [MESSAGE(1, { content: "x".repeat(TRANSCRIPT_MAX_CHARS * 2) })],
      80,
      100,
    );
    expect(selection.messages).toHaveLength(1);
  });

  it("reports nothing dropped for an empty room", () => {
    expect(selectTurnMessages([], 80, 100)).toEqual({ messages: [], droppedEarlier: 0 });
  });
});

describe("buildCouncilTurnPrompt", () => {
  it("shows the messages with their number and author", () => {
    const prompt = buildCouncilTurnPrompt({
      memberName: "acorn",
      messages: [
        MESSAGE(4, { authorName: "blade", addressedNames: ["acorn"], content: "ping" }),
        MESSAGE(5, { authorKind: "user", authorName: "you", content: "carry on" }),
      ],
      addressed: true,
    });
    expect(prompt).toContain("#4 blade → acorn:");
    expect(prompt).toContain("ping");
    expect(prompt).toContain("#5 you (the owner):");
    expect(prompt).toContain("carry on");
  });

  it("says why it was woken", () => {
    expect(
      buildCouncilTurnPrompt({ memberName: "acorn", messages: [MESSAGE(1)], addressed: true }),
    ).toMatch(/You were addressed/);
    expect(
      buildCouncilTurnPrompt({ memberName: "acorn", messages: [MESSAGE(1)], addressed: false }),
    ).toMatch(/the room moved on/);
    expect(
      buildCouncilTurnPrompt({
        memberName: "acorn",
        messages: [MESSAGE(1)],
        addressed: false,
        round: 3,
      }),
    ).toMatch(/your turn in round 3/);
  });

  it("restates the posting rule every turn", () => {
    const prompt = buildCouncilTurnPrompt({
      memberName: "acorn",
      messages: [MESSAGE(1)],
      addressed: true,
    });
    expect(prompt).toMatch(/cannot see anything else you write/);
    expect(prompt).toContain("council_post");
  });

  it("points at council_read when older messages were left out", () => {
    const messages = Array.from({ length: 10 }, (_, i) => MESSAGE(i + 1));
    const prompt = buildCouncilTurnPrompt({ memberName: "acorn", messages, addressed: false });
    // 80-message window keeps all ten, so nothing is claimed to be missing.
    expect(prompt).not.toContain("council_read");

    const wide = buildCouncilTurnPrompt({
      memberName: "acorn",
      messages: messages.map((m) => ({ ...m, content: "y".repeat(9000) })),
      addressed: false,
    });
    expect(wide).toMatch(/older messages in the room are not shown/);
    expect(wide).toContain("council_read");
  });

  it("handles an empty room without pretending there is something to read", () => {
    const prompt = buildCouncilTurnPrompt({ memberName: "acorn", messages: [], addressed: false });
    expect(prompt).toContain("(nothing new)");
  });

  it("reminds the member where its workspace is", () => {
    const prompt = buildCouncilTurnPrompt({
      memberName: "acorn",
      messages: [],
      addressed: false,
      sandboxPath: "/home/uabcd1234",
    });
    expect(prompt).toContain("/home/uabcd1234");
  });
});
