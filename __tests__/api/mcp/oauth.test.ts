import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireSession = vi.fn();
const mockFindFirst = vi.fn();
const mockEvictUserSessions = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
  },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: (...args: unknown[]) => mockEvictUserSessions(...args),
}));

const mockStart = vi.fn();
const mockReadFlow = vi.fn();
const mockHasCredential = vi.fn();
const mockClearCredential = vi.fn();
const mockClearFlow = vi.fn();
const mockResolveState = vi.fn();
const mockComplete = vi.fn();
const mockMarkSucceeded = vi.fn();
const mockFail = vi.fn();
const mockClearState = vi.fn();

vi.mock("@/lib/mcp/oauth", () => ({
  startMcpOAuthSignIn: (...args: unknown[]) => mockStart(...args),
  readMcpOAuthFlow: (...args: unknown[]) => mockReadFlow(...args),
  hasMcpOAuthCredential: (...args: unknown[]) => mockHasCredential(...args),
  clearMcpOAuthCredential: (...args: unknown[]) => mockClearCredential(...args),
  clearMcpOAuthFlow: (...args: unknown[]) => mockClearFlow(...args),
  resolveMcpOAuthState: (...args: unknown[]) => mockResolveState(...args),
  completeMcpOAuthSignIn: (...args: unknown[]) => mockComplete(...args),
  markMcpOAuthSignInSucceeded: (...args: unknown[]) => mockMarkSucceeded(...args),
  failMcpOAuthSignIn: (...args: unknown[]) => mockFail(...args),
  clearMcpOAuthState: (...args: unknown[]) => mockClearState(...args),
}));

import { POST as startOAuth } from "@/app/api/mcp/servers/[serverId]/oauth/start/route";
import { GET as oauthState, DELETE as signOut } from "@/app/api/mcp/servers/[serverId]/oauth/route";
import { GET as callback } from "@/app/api/mcp/oauth/callback/route";

const USER_ID = "user-1";

function auth() {
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
}

function params(serverId: string) {
  return { params: Promise.resolve({ serverId }) };
}

function request(url = "http://localhost/api/mcp") {
  return new NextRequest(url, { method: "POST" });
}

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    userId: USER_ID,
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    description: "",
    encryptedToken: null,
    toolPolicy: "ask",
    enabled: true,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
    ...overrides,
  };
}

describe("/api/mcp/servers/:serverId/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth();
    mockFindFirst.mockResolvedValue(serverRow());
    mockEvictUserSessions.mockResolvedValue(0);
  });

  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await startOAuth(request(), params("srv-1"))).status).toBe(401);
  });

  it("404s for a server the caller does not own", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect((await startOAuth(request(), params("srv-x"))).status).toBe(404);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns the authorization URL and leaves pooled sessions alone", async () => {
    mockStart.mockResolvedValue({ status: "pending", authorizationUrl: "https://as.example/a" });

    const response = await startOAuth(request(), params("srv-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "pending",
      authorizationUrl: "https://as.example/a",
    });
    expect(mockEvictUserSessions).not.toHaveBeenCalled();
  });

  it("evicts pooled sessions when a stored refresh token completes the sign-in", async () => {
    mockStart.mockResolvedValue({ status: "succeeded", authorizationUrl: null });

    await startOAuth(request(), params("srv-1"));

    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("reports a failure to start as a 502", async () => {
    mockStart.mockRejectedValue(new Error("discovery failed"));
    const response = await startOAuth(request(), params("srv-1"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "discovery failed" });
  });
});

describe("/api/mcp/servers/:serverId/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth();
    mockFindFirst.mockResolvedValue(serverRow());
    mockEvictUserSessions.mockResolvedValue(0);
  });

  it("reports the sign-in state and whether credentials are stored", async () => {
    mockReadFlow.mockResolvedValue({
      status: "pending",
      error: null,
      authorizationUrl: "https://as.example/a",
    });
    mockHasCredential.mockResolvedValue(false);

    const body = await (await oauthState(request(), params("srv-1"))).json();

    expect(body).toEqual({
      status: "pending",
      error: null,
      authorizationUrl: "https://as.example/a",
      hasOAuth: false,
    });
  });

  it("reports idle when no sign-in is running", async () => {
    mockReadFlow.mockResolvedValue(null);
    mockHasCredential.mockResolvedValue(true);

    expect(await (await oauthState(request(), params("srv-1"))).json()).toMatchObject({
      status: "idle",
      hasOAuth: true,
    });
  });

  it("signs out by clearing credentials and the browser state", async () => {
    mockClearCredential.mockResolvedValue(undefined);
    mockClearFlow.mockResolvedValue(undefined);

    const response = await signOut(request(), params("srv-1"));

    expect(await response.json()).toEqual({ ok: true });
    expect(mockClearCredential).toHaveBeenCalledWith(USER_ID, "srv-1");
    expect(mockClearFlow).toHaveBeenCalledWith("srv-1");
    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
  });
});

describe("/api/mcp/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(serverRow());
    mockEvictUserSessions.mockResolvedValue(0);
  });

  it("rejects a callback without a state", async () => {
    const response = await callback(
      new NextRequest("http://localhost/api/mcp/oauth/callback?code=abc"),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/state/);
  });

  it("rejects a state that is unknown or expired", async () => {
    mockResolveState.mockResolvedValue(null);
    const response = await callback(
      new NextRequest("http://localhost/api/mcp/oauth/callback?state=unknown&code=abc"),
    );
    expect(response.status).toBe(400);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("exchanges the code, records success and evicts pooled sessions", async () => {
    mockResolveState.mockResolvedValue({ userId: USER_ID, serverId: "srv-1" });
    mockComplete.mockResolvedValue(undefined);
    mockMarkSucceeded.mockResolvedValue(undefined);
    mockClearState.mockResolvedValue(undefined);

    const response = await callback(
      new NextRequest("http://localhost/api/mcp/oauth/callback?state=s&code=abc&iss=as"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/connected/i);
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "srv-1", userId: USER_ID }),
      { code: "abc", iss: "as" },
    );
    expect(mockMarkSucceeded).toHaveBeenCalledWith(USER_ID, "srv-1");
    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
    // The state is single-use.
    expect(mockClearState).toHaveBeenCalledWith("s");
  });

  it("records a provider-side error", async () => {
    mockResolveState.mockResolvedValue({ userId: USER_ID, serverId: "srv-1" });
    mockFail.mockResolvedValue(undefined);
    mockClearState.mockResolvedValue(undefined);

    const response = await callback(
      new NextRequest(
        "http://localhost/api/mcp/oauth/callback?state=s&error=access_denied&error_description=no",
      ),
    );

    expect(response.status).toBe(400);
    expect(mockFail).toHaveBeenCalledWith(USER_ID, "srv-1", "no");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("records a failed exchange", async () => {
    mockResolveState.mockResolvedValue({ userId: USER_ID, serverId: "srv-1" });
    mockComplete.mockRejectedValue(new Error("invalid_grant"));
    mockFail.mockResolvedValue(undefined);
    mockClearState.mockResolvedValue(undefined);

    const response = await callback(
      new NextRequest("http://localhost/api/mcp/oauth/callback?state=s&code=abc"),
    );

    expect(response.status).toBe(400);
    expect(mockFail).toHaveBeenCalledWith(USER_ID, "srv-1", "invalid_grant");
  });
});
