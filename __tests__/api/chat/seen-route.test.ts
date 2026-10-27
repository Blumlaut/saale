import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * The seen route is what lets a finished reply skip the push on every device:
 * the open chat reports itself, and the timestamp is keyed by the user.
 */

const { mockRequireChatSessionOwner, mockMarkChatSeen } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockMarkChatSeen: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/redis", () => ({ markChatSeen: mockMarkChatSeen }));

import { POST } from "@/app/api/chat/sessions/[sessionId]/seen/route";

const USER_ID = "seen-route-user";
const SESSION_ID = "seen-route-session";

function seen() {
  return POST(new NextRequest("http://localhost/api/chat/sessions/x/seen", { method: "POST" }), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
}

describe("POST /api/chat/sessions/:sessionId/seen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      session: { id: SESSION_ID },
    });
    mockMarkChatSeen.mockResolvedValue(undefined);
  });

  it("records the chat as seen for its owner", async () => {
    const response = await seen();

    expect(mockRequireChatSessionOwner).toHaveBeenCalledWith(SESSION_ID);
    expect(mockMarkChatSeen).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(response.status).toBe(204);
  });

  it("records nothing for a chat the caller does not own", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });

    const response = await seen();

    expect(response.status).toBe(404);
    expect(mockMarkChatSeen).not.toHaveBeenCalled();
  });
});
