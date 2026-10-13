import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCouncilTools, type CouncilToolContext } from "@/lib/council/tools";
import { MAX_MESSAGE_LENGTH } from "@/lib/council/config";

/* eslint-disable @typescript-eslint/no-explicit-any */

const callExecute = async (tool: unknown, params: Record<string, unknown> = {}) =>
  (tool as any).execute("call-1", params, undefined, undefined, {} as never);

const MEMBERS = [
  { id: "m1", name: "acorn" },
  { id: "m2", name: "blade" },
  { id: "m3", name: "cobalt" },
];

function makeContext(overrides: Partial<CouncilToolContext> = {}) {
  const context: CouncilToolContext = {
    member: { id: "m1", name: "acorn" },
    members: MEMBERS,
    post: vi.fn(async () => ({ seq: 7, wokeNames: [] })),
    read: vi.fn(async () => ({ messages: [], lastSeq: 0 })),
    vote: vi.fn(async () => ({ votes: 1, needed: 2, stopped: false })),
    ...overrides,
  };
  const tools = createCouncilTools(context);
  return { context, tools, byName: (name: string) => tools.find((t) => t.name === name)! };
}

describe("council tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes the three tools a member acts with", () => {
    const { tools } = makeContext();
    expect(tools.map((tool) => tool.name)).toEqual([
      "council_post",
      "council_read",
      "council_vote_stop",
    ]);
  });

  it("gives every tool an output schema, so a script gets a value", () => {
    for (const tool of makeContext().tools) {
      expect((tool as any).outputSchema, `${tool.name} has no outputSchema`).toBeTruthy();
    }
  });
});

describe("council_post", () => {
  it("posts the message and reports who it woke", async () => {
    const { context, byName } = makeContext({
      post: vi.fn(async () => ({ seq: 12, wokeNames: ["blade"] })),
    });

    const result = await callExecute(byName("council_post"), {
      content: "@blade can you check the parse step?",
    });

    expect(context.post).toHaveBeenCalledWith({
      content: "@blade can you check the parse step?",
      memberIds: ["m2"],
      addressesUser: false,
      addressedAll: false,
    });
    expect(result.structuredContent).toEqual({
      posted: true,
      seq: 12,
      woke: ["blade"],
      addressedUser: false,
    });
  });

  it("resolves @all and @user without naming them to post()", async () => {
    const { context, byName } = makeContext();
    await callExecute(byName("council_post"), { content: "@all status? @user we need a call" });
    expect(context.post).toHaveBeenCalledWith(
      expect.objectContaining({ memberIds: [], addressesUser: true }),
    );
  });

  it("trims the message before storing it", async () => {
    const { context, byName } = makeContext();
    await callExecute(byName("council_post"), { content: "  hello room  \n" });
    expect(context.post).toHaveBeenCalledWith(expect.objectContaining({ content: "hello room" }));
  });

  it("refuses an empty message", async () => {
    const { context, byName } = makeContext();
    await expect(callExecute(byName("council_post"), { content: "   " })).rejects.toThrow(
      /cannot be empty/,
    );
    expect(context.post).not.toHaveBeenCalled();
  });

  it("refuses a message over the length limit rather than truncating it", async () => {
    const { context, byName } = makeContext();
    const long = "x".repeat(MAX_MESSAGE_LENGTH + 1);
    await expect(callExecute(byName("council_post"), { content: long })).rejects.toThrow(
      /the limit is/,
    );
    expect(context.post).not.toHaveBeenCalled();
  });

  it("refuses an unknown handle instead of posting to nobody", async () => {
    const { context, byName } = makeContext();
    await expect(
      callExecute(byName("council_post"), { content: "@ghost take a look" }),
    ).rejects.toThrow(/Unknown member @ghost/);
    // The error names who *can* be addressed.
    await expect(
      callExecute(byName("council_post"), { content: "@ghost take a look" }),
    ).rejects.toThrow(/@acorn/);
    expect(context.post).not.toHaveBeenCalled();
  });

  it("does not read an email address as a mention", async () => {
    const { context, byName } = makeContext();
    await callExecute(byName("council_post"), { content: "mail ops@ghost.example.com" });
    expect(context.post).toHaveBeenCalledWith(
      expect.objectContaining({ memberIds: [], addressesUser: false }),
    );
  });

  it("tells the model when its post reached nobody", async () => {
    const { byName } = makeContext();
    const result = await callExecute(byName("council_post"), { content: "thinking out loud" });
    expect(result.content[0].text).toMatch(/Nobody was addressed/);
  });

  it("tells the model who it woke", async () => {
    const { byName } = makeContext({
      post: vi.fn(async () => ({ seq: 3, wokeNames: ["blade", "cobalt"] })),
    });
    const result = await callExecute(byName("council_post"), { content: "@blade @cobalt ping" });
    expect(result.content[0].text).toMatch(/Woke @blade, @cobalt/);
  });
});

describe("council_read", () => {
  it("passes the window through and reports the room length", async () => {
    const { context, byName } = makeContext({
      read: vi.fn(async () => ({
        lastSeq: 40,
        messages: [
          {
            seq: 39,
            memberId: "m2",
            authorName: "blade",
            authorKind: "member" as const,
            addressedNames: [],
            content: "done",
          },
          {
            seq: 40,
            memberId: null,
            authorName: "you",
            authorKind: "user" as const,
            addressedNames: ["acorn"],
            content: "thanks",
          },
        ],
      })),
    });

    const result = await callExecute(byName("council_read"), { sinceSeq: 38, limit: 2 });

    expect(context.read).toHaveBeenCalledWith({ sinceSeq: 38, limit: 2 });
    expect(result.structuredContent).toMatchObject({ count: 2, lastSeq: 40 });
  });

  it("defaults the window and clamps a silly limit", async () => {
    const { context, byName } = makeContext();
    await callExecute(byName("council_read"), {});
    expect(context.read).toHaveBeenCalledWith({ limit: 20 });

    await callExecute(byName("council_read"), { limit: 100000 });
    expect(context.read).toHaveBeenLastCalledWith({ limit: 100 });

    await callExecute(byName("council_read"), { limit: 0 });
    expect(context.read).toHaveBeenLastCalledWith({ limit: 1 });
  });

  it("filters by author, resolving the handle", async () => {
    const { context, byName } = makeContext();
    await callExecute(byName("council_read"), { author: "@blade" });
    expect(context.read).toHaveBeenCalledWith({ limit: 20, author: "blade", authorId: "m2" });
  });

  it("refuses an author who is not a member", async () => {
    const { byName } = makeContext();
    await expect(callExecute(byName("council_read"), { author: "ghost" })).rejects.toThrow(
      /No member called "ghost"/,
    );
  });
});

describe("council_vote_stop", () => {
  it("records the vote and reports the tally", async () => {
    const { context, byName } = makeContext({
      vote: vi.fn(async () => ({ votes: 2, needed: 2, stopped: true })),
    });

    const result = await callExecute(byName("council_vote_stop"), {
      reason: "The plan is written and reviewed.",
      kind: "consensus",
    });

    expect(context.vote).toHaveBeenCalledWith({
      reason: "The plan is written and reviewed.",
      kind: "consensus",
    });
    expect(result.structuredContent).toEqual({ voted: true, votes: 2, needed: 2, stopped: true });
    expect(result.content[0].text).toMatch(/The run is ending/);
  });

  it("tells the model the run continues when the vote is not enough", async () => {
    const { byName } = makeContext({
      vote: vi.fn(async () => ({ votes: 1, needed: 3, stopped: false })),
    });
    const result = await callExecute(byName("council_vote_stop"), {
      reason: "I think we are done.",
      kind: "done",
    });
    expect(result.content[0].text).toMatch(/The run continues/);
  });

  it("requires a reason, since the others read it", async () => {
    const { context, byName } = makeContext();
    await expect(
      callExecute(byName("council_vote_stop"), { reason: "  ", kind: "done" }),
    ).rejects.toThrow(/needs a reason/);
    expect(context.vote).not.toHaveBeenCalled();
  });
});
