import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateMessage, mockUpdateSession, mockFindSession, mockNotify, mockNote, mockPublish } =
  vi.hoisted(() => ({
    mockCreateMessage: vi.fn(),
    mockUpdateSession: vi.fn(),
    mockFindSession: vi.fn(),
    mockNotify: vi.fn(),
    mockNote: vi.fn(),
    mockPublish: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: { create: mockCreateMessage },
    chatSession: { update: mockUpdateSession, findFirst: mockFindSession },
  },
}));
vi.mock("@/lib/notifications/notify", () => ({ notifyUser: mockNotify }));
vi.mock("@/lib/pi/session-notes", () => ({ appendSessionNote: mockNote }));
vi.mock("@/lib/pi/session-events", () => ({ publishSessionEvent: mockPublish }));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import {
  announceTickFailure,
  AUTOMATION_FAILURE_NOTE_TYPE,
  failureNoticeEarned,
  failureText,
} from "@/lib/watchers/failure";
import type { TickOutcome } from "@/lib/watchers/tick";

const watcher = {
  id: "w-1",
  userId: "user-1",
  name: "Watch the inbox",
  sessionId: "chat-1",
  originSessionId: "chat-0",
};

function outcome(overrides: Partial<TickOutcome> = {}): TickOutcome {
  return {
    status: "blocked",
    reason: "The run stalled: nothing happened for 10 minutes",
    output: "",
    durationMs: 0,
    callCount: 0,
    callNames: [],
    ...overrides,
  };
}

/** The same object with no reason recorded. */
function withoutReason(overrides: Partial<TickOutcome> = {}): TickOutcome {
  const { reason: _reason, ...rest } = outcome(overrides);
  return rest;
}

describe("failureNoticeEarned", () => {
  it("speaks up when a wake could not be delivered", () => {
    expect(failureNoticeEarned(null, outcome())).toBe(true);
  });

  it("says nothing about a tick that worked", () => {
    expect(failureNoticeEarned(null, withoutReason({ status: "idle" }))).toBe(false);
    expect(failureNoticeEarned(null, withoutReason({ status: "fired" }))).toBe(false);
  });

  it("repeats itself only when the failure changed", () => {
    const reason = "The run stalled: nothing happened for 10 minutes";

    expect(failureNoticeEarned(reason, outcome({ reason }))).toBe(false);
    expect(failureNoticeEarned(reason, outcome({ reason: "Chat is busy" }))).toBe(true);
    expect(failureNoticeEarned(null, withoutReason())).toBe(true);
  });
});

describe("failureText", () => {
  it("carries the reason as one sentence, whatever it ended with", () => {
    expect(failureText("Watch", "The script threw.")).toBe(
      'Automation "Watch" failed: The script threw. What it would have reported never arrived.',
    );
  });
});

describe("announceTickFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMessage.mockResolvedValue({});
    mockUpdateSession.mockResolvedValue({});
    mockFindSession.mockResolvedValue({ id: "chat-1" });
    mockNote.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
  });

  it("puts the failure in the chat the fire was meant for", async () => {
    await announceTickFailure({ watcher, outcome: outcome() });

    const text = failureText(watcher.name, outcome().reason!);
    expect(mockCreateMessage).toHaveBeenCalledWith({
      data: { sessionId: "chat-1", role: "system", content: text },
    });
    expect(mockUpdateSession).toHaveBeenCalledWith({
      where: { id: "chat-1", userId: "user-1" },
      data: { lastActivityAt: expect.any(Date), messageCount: { increment: 1 } },
    });
    expect(mockPublish).toHaveBeenCalledWith("chat-1", "messages_changed", {});
  });

  it("does not write into a chat the automation's owner does not own", async () => {
    mockFindSession.mockResolvedValue(null);

    await announceTickFailure({ watcher, outcome: outcome() });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled();
  });

  it("notes it in the transcript the agent reads", async () => {
    await announceTickFailure({ watcher, outcome: outcome() });

    expect(mockNote).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "chat-1",
      type: AUTOMATION_FAILURE_NOTE_TYPE,
      text: failureText(watcher.name, outcome().reason!),
    });
  });

  it("rings the bell, whether or not push reaches a device", async () => {
    await announceTickFailure({ watcher, outcome: outcome() });

    expect(mockNotify).toHaveBeenCalledWith({
      userId: "user-1",
      category: "automation",
      title: 'Automation "Watch the inbox" failed',
      body: outcome().reason,
      url: "/dashboard/jobs/automations?id=w-1",
      tag: "automation-w-1",
      inApp: true,
    });
  });

  it("falls back to the chat the automation was created from", async () => {
    await announceTickFailure({ watcher: { ...watcher, sessionId: null }, outcome: outcome() });

    expect(mockFindSession).toHaveBeenCalledWith({
      where: { id: "chat-0", userId: "user-1" },
      select: { id: true },
    });
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sessionId: "chat-0" }) }),
    );
  });

  it("writes no chat when the automation has neither", async () => {
    await announceTickFailure({
      watcher: { ...watcher, sessionId: null, originSessionId: null },
      outcome: outcome(),
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockNote).not.toHaveBeenCalled();
    // The user is still the one who has to know.
    expect(mockNotify).toHaveBeenCalled();
  });

  it("still rings the bell when the chat could not be written", async () => {
    mockCreateMessage.mockRejectedValue(new Error("db down"));

    await expect(announceTickFailure({ watcher, outcome: outcome() })).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled();
  });
});
