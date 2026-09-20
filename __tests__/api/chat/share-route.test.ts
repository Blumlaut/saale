import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockRequireChatSessionOwner, mockUpdate, mockGenerateShareToken } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockUpdate: vi.fn(),
  mockGenerateShareToken: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/chat/share", () => ({ generateShareToken: mockGenerateShareToken }));
vi.mock("@/lib/db", () => ({ prisma: { chatSession: { update: mockUpdate } } }));

import { GET, POST, DELETE } from "@/app/api/chat/sessions/[sessionId]/share/route";

const USER_ID = "share-route-user";
const SESSION_ID = "share-route-session";

function params() {
  return { params: Promise.resolve({ sessionId: SESSION_ID }) };
}

function getSession(shared: boolean, shareToken: string | null) {
  return { shared, shareToken };
}

function authWith(session: { shared: boolean; shareToken: string | null }) {
  mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session });
}

describe("GET /api/chat/sessions/[sessionId]/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockGenerateShareToken.mockReturnValue("fresh-token");
  });

  it("returns isShared and the share URL when the chat is shared", async () => {
    authWith(getSession(true, "abc123"));

    const res = await GET(new NextRequest("http://localhost/api/x", { method: "GET" }), params());
    await expect(res.json()).resolves.toEqual({
      ok: true,
      isShared: true,
      shareUrl: "/share/abc123",
    });
  });

  it("returns isShared false when the chat is not shared", async () => {
    authWith(getSession(false, null));

    const res = await GET(new NextRequest("http://localhost/api/x", { method: "GET" }), params());
    await expect(res.json()).resolves.toEqual({ ok: true, isShared: false });
  });

  it("treats a session with shared=true but no token as not shared", async () => {
    // Defensive: the token is the only thing that makes a share link valid.
    authWith(getSession(true, null));

    const res = await GET(new NextRequest("http://localhost/api/x", { method: "GET" }), params());
    await expect(res.json()).resolves.toEqual({ ok: true, isShared: false });
  });

  it("propagates auth failures", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });

    const res = await GET(new NextRequest("http://localhost/api/x", { method: "GET" }), params());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat/sessions/[sessionId]/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockGenerateShareToken.mockReturnValue("fresh-token");
  });

  it("is idempotent and reuses the existing token", async () => {
    authWith(getSession(true, "abc123"));

    const res = await POST(new NextRequest("http://localhost/api/x", { method: "POST" }), params());
    const body = await res.json();

    expect(body).toEqual({
      ok: true,
      shareUrl: "/share/abc123",
      shareToken: "abc123",
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockGenerateShareToken).not.toHaveBeenCalled();
  });

  it("creates a new token and marks the session shared", async () => {
    authWith(getSession(false, null));

    const res = await POST(new NextRequest("http://localhost/api/x", { method: "POST" }), params());
    const body = await res.json();

    expect(body.shareToken).toBe("fresh-token");
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { shared: true, shareToken: "fresh-token" },
    });
  });
});

describe("DELETE /api/chat/sessions/[sessionId]/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
  });

  it("clears the token and unshares the session", async () => {
    authWith(getSession(true, "abc123"));

    const res = await DELETE(
      new NextRequest("http://localhost/api/x", { method: "DELETE" }),
      params(),
    );

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: { shared: false, shareToken: null },
    });
  });
});
