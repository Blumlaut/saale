import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The command route is the web surface's only entrypoint. Authentication and
 * the context it builds are the route's own responsibility — the command
 * itself (and every guardrail) lives behind `executeCommand`.
 */

const { mockRequireChatSessionOwner, mockExecuteCommand } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockExecuteCommand: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/commands/execute", () => ({ executeCommand: mockExecuteCommand }));

import { POST } from "@/app/api/chat/sessions/[sessionId]/command/route";

const USER_ID = "command-user";
const SESSION_ID = "command-session";

function post(body: unknown, raw?: string) {
  return POST(
    new NextRequest("http://localhost/api/chat/sessions/x/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

describe("POST /api/chat/sessions/[sessionId]/command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  it("refuses a session the caller does not own", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    });

    const res = await post({ name: "stop" });

    expect(res.status).toBe(404);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await post(null, "not json");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON");
  });

  it("requires a command name", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ name: "" })).status).toBe(400);
    expect((await post({ name: 42 })).status).toBe(400);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("rejects non-string args or value", async () => {
    expect((await post({ name: "model", args: 1 })).status).toBe(400);
    expect((await post({ name: "model", value: 1 })).status).toBe(400);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("runs the command with the authenticated web context", async () => {
    mockExecuteCommand.mockResolvedValue({
      kind: "done",
      name: "stfu",
      outcome: { message: "ok" },
    });

    const res = await post({ name: "stfu", args: "stop" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "done", name: "stfu", outcome: { message: "ok" } });
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "stfu",
      { surface: "web", userId: USER_ID, sessionId: SESSION_ID, args: "stop" },
      undefined,
    );
  });

  it("passes a prompt back to the client", async () => {
    const prompt = { title: "Model", options: [{ value: "a", label: "A" }] };
    mockExecuteCommand.mockResolvedValue({ kind: "prompt", name: "model", prompt });

    const res = await post({ name: "model" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "prompt", name: "model", prompt });
  });

  it("forwards a chosen value", async () => {
    mockExecuteCommand.mockResolvedValue({
      kind: "done",
      name: "model",
      outcome: { message: "ok" },
    });

    await post({ name: "model", value: "anthropic:claude" });

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "model",
      { surface: "web", userId: USER_ID, sessionId: SESSION_ID, args: "" },
      "anthropic:claude",
    );
  });

  it("reports a command-level failure as 400 with its message", async () => {
    mockExecuteCommand.mockResolvedValue({
      kind: "error",
      name: "nope",
      error: "Unknown command: /nope",
    });

    const res = await post({ name: "nope" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown command: /nope");
  });
});
