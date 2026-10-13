import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(async () => ({ ok: true, user: { id: "user-1" } })),
}));

vi.mock("@/lib/settings/update", () => ({
  isAdminUser: vi.fn(async () => true),
}));

vi.mock("@/lib/council/store", () => ({
  getCouncil: vi.fn(),
  listRoomMessages: vi.fn(async () => []),
  CouncilInputError: class CouncilInputError extends Error {},
}));

vi.mock("@/lib/council/run", async () => {
  class CouncilBusyError extends Error {}
  class CouncilNotFoundError extends Error {}
  class CouncilUnavailableError extends Error {}
  return {
    CouncilBusyError,
    CouncilNotFoundError,
    CouncilUnavailableError,
    startCouncilRun: vi.fn(async () => ({ runId: "run-1" })),
  };
});

vi.mock("@/lib/council/persist", () => ({
  loadOwnerName: vi.fn(async () => "Ada"),
  postRoomMessage: vi.fn(async (input: any) => ({
    id: "msg-1",
    seq: 1,
    memberId: null,
    authorName: input.authorName,
    authorKind: input.authorKind,
    content: input.content,
    addressedNames: input.mentions,
  })),
}));

vi.mock("@/lib/council/events", () => ({
  publishRoomMessage: vi.fn(async () => {}),
}));

import { requireSession } from "@/lib/auth";
import { isAdminUser } from "@/lib/settings/update";
import { getCouncil } from "@/lib/council/store";
import { CouncilBusyError, startCouncilRun } from "@/lib/council/run";
import { postRoomMessage } from "@/lib/council/persist";
import { publishRoomMessage } from "@/lib/council/events";
import { GET, POST } from "@/app/api/council/[councilId]/messages/route";

const COUNCIL = {
  id: "council-1",
  name: "Launch review",
  brief: "Decide.",
  orchestration: "parallel",
  stopVoteThreshold: "majority",
  toolConfig: {},
  maxDurationSeconds: null,
  maxTokens: null,
  maxCostUsd: null,
  status: "idle",
  sandboxReady: false,
  memberCount: 2,
  enabledMemberCount: 2,
  lastRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  members: [
    member("m1", "acorn"),
    member("m2", "blade"),
    { ...member("m3", "cobalt"), enabled: false },
  ],
  runs: [],
  lastSeq: 4,
  activeRun: null,
};

function member(id: string, name: string) {
  return {
    id,
    name,
    instructions: null,
    modelProvider: null,
    modelName: null,
    thinkingLevel: "default",
    toolConfig: null,
    enabled: true,
  };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/council/council-1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ councilId: "council-1" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ ok: true, user: { id: "user-1" } } as any);
  vi.mocked(isAdminUser).mockResolvedValue(true);
  vi.mocked(getCouncil).mockResolvedValue(COUNCIL as any);
  vi.mocked(startCouncilRun).mockResolvedValue({ runId: "run-1" } as any);
});

describe("POST /api/council/[councilId]/messages", () => {
  it("stores the owner's message with the members it addressed", async () => {
    const response = await POST(post({ content: "@blade what do you think?", startRun: true }), {
      params,
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.runStarted).toBe(true);
    expect(vi.mocked(postRoomMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        authorKind: "user",
        authorName: "Ada",
        mentions: ["blade"],
      }),
    );
    // The woken member is the opening's scope, so nobody else is disturbed.
    expect(vi.mocked(startCouncilRun)).toHaveBeenCalledWith(
      expect.objectContaining({ openingMemberIds: ["m2"] }),
    );
    expect(publishRoomMessage).toHaveBeenCalled();
  });

  it("refuses a handle that names nobody, rather than storing a message to nobody", async () => {
    const response = await POST(post({ content: "@ghost take a look" }), { params });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Unknown member @ghost/);
    expect(body.error).toMatch(/@acorn/);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it("keeps the message when the room is already working, and joins the run", async () => {
    vi.mocked(startCouncilRun).mockRejectedValue(new CouncilBusyError("busy"));

    const response = await POST(post({ content: "one more thing" }), { params });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.runStarted).toBe(false);
    expect(body.running).toBe(true);
    // The message is in the room either way — the working loop picks it up.
    expect(postRoomMessage).toHaveBeenCalled();
  });

  it("does not start a run when the caller only wants to leave a note", async () => {
    const response = await POST(post({ content: "noted", startRun: false }), { params });

    expect(response.status).toBe(201);
    expect(startCouncilRun).not.toHaveBeenCalled();
    expect((await response.json()).running).toBe(false);
  });

  it("ignores a disabled member when resolving handles", async () => {
    const response = await POST(post({ content: "@cobalt hello" }), { params });

    expect(response.status).toBe(400);
  });

  it("rejects an empty message", async () => {
    const response = await POST(post({ content: "   " }), { params });
    expect(response.status).toBe(400);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it("answers 404 for a council that is not the caller's", async () => {
    vi.mocked(getCouncil).mockResolvedValue(null);
    const response = await POST(post({ content: "hello" }), { params });
    expect(response.status).toBe(404);
  });

  it("hides the whole endpoint from a non-admin", async () => {
    vi.mocked(isAdminUser).mockResolvedValue(false);
    const response = await POST(post({ content: "hello" }), { params });
    expect(response.status).toBe(404);
    expect(getCouncil).not.toHaveBeenCalled();
  });

  it("hides the endpoint from a caller with no session", async () => {
    vi.mocked(requireSession).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }) as any,
    });
    const response = await POST(post({ content: "hello" }), { params });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/council/[councilId]/messages", () => {
  it("returns the room's newest messages and its length", async () => {
    const { listRoomMessages } = await import("@/lib/council/store");
    vi.mocked(listRoomMessages).mockResolvedValue([
      {
        seq: 9,
        memberId: "m2",
        authorName: "blade",
        authorKind: "member",
        content: "done",
        addressedNames: [],
        runId: "run-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ] as any);

    const request = new NextRequest("http://localhost/api/council/council-1/messages?limit=10");
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.lastSeq).toBe(9);
    expect(listRoomMessages).toHaveBeenCalledWith("user-1", "council-1", { limit: 10 });
  });

  it("refuses a nonsense sinceSeq instead of returning the whole room", async () => {
    const request = new NextRequest("http://localhost/api/council/council-1/messages?sinceSeq=abc");
    const response = await GET(request, { params });
    expect(response.status).toBe(400);
  });
});
