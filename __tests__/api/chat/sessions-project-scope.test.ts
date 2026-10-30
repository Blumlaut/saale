import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Coder chats share the chat table, so the chat list has to keep them out.
 *
 * Without `?projectId=` the list must be exactly what it was before coder
 * chats existed (`projectId: null`), and with it the project's chats. Creating
 * one checks the project against the user: a guessed id must not attach a chat
 * to someone else's repo.
 */

const {
  mockRequireSession,
  mockFindMany,
  mockCreate,
  mockGetActiveSessions,
  mockOwnedProjectId,
  mockGetProjectSettings,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockGetActiveSessions: vi.fn(),
  mockOwnedProjectId: vi.fn(),
  mockGetProjectSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: mockRequireSession }));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findMany: mockFindMany, create: mockCreate },
    // A coder chat's tool config comes from the user's coder defaults.
    appSettings: { findUnique: vi.fn(async () => ({ coderToolConfig: null })) },
  },
}));

vi.mock("@/lib/redis", () => ({ getActiveSessions: mockGetActiveSessions }));

vi.mock("@/lib/coder/projects", () => ({
  ownedProjectId: mockOwnedProjectId,
  getProjectSettings: mockGetProjectSettings,
}));

import { GET, POST } from "@/app/api/chat/sessions/route";

const USER = "user-1";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const STORED_ROW = {
  id: "chat-1",
  title: "Normal chat",
  temporary: false,
  messageCount: 2,
  origin: "user",
  coderWorktree: null,
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
  _count: { scriptWatchers: 0 },
};

const PROJECT = {
  id: "project-1",
  name: "Saale Web",
  slug: "saale-web",
  repoPath: "projects/saale-web",
  defaultBranch: "main",
  originUrl: null,
  envFiles: [],
  setupScript: null,
  chatMode: "worktree" as const,
};

function listRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/chat/sessions${query}`);
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER, email: "ada@example.com" } });
  mockFindMany.mockResolvedValue([STORED_ROW]);
  mockGetActiveSessions.mockResolvedValue(new Set<string>());
  mockOwnedProjectId.mockResolvedValue(null);
  mockGetProjectSettings.mockResolvedValue(PROJECT);
  mockCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...STORED_ROW, ...data }),
  );
});

describe("GET /api/chat/sessions", () => {
  it("lists only normal chats when no project is given", async () => {
    const res = await GET(listRequest());

    expect(res.status).toBe(200);
    const args = mockFindMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ userId: USER, projectId: null });
    const body = (await res.json()) as { sessions: Array<{ id: string; isGenerating: boolean }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.id).toBe("chat-1");
    expect(body.sessions[0]?.isGenerating).toBe(false);
  });

  it("lists one project's coder chats when a project is given", async () => {
    const res = await GET(listRequest("?projectId=project-1"));

    expect(res.status).toBe(200);
    expect(mockGetProjectSettings).toHaveBeenCalledWith(USER, "project-1");
    const args = mockFindMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ userId: USER, projectId: "project-1" });
  });

  it("names the project and each chat's branch in a project's list", async () => {
    mockFindMany.mockResolvedValue([
      { ...STORED_ROW, origin: "watcher", coderWorktree: { branch: "wt/chat-1" } },
    ]);

    const res = await GET(listRequest("?projectId=project-1"));
    const body = (await res.json()) as {
      project: { name: string; slug: string; defaultBranch: string } | null;
      sessions: Array<{ origin: string; worktree: { branch: string } | null }>;
    };

    expect(body.project).toEqual({
      id: "project-1",
      name: "Saale Web",
      slug: "saale-web",
      defaultBranch: "main",
    });
    expect(body.sessions[0]?.origin).toBe("watcher");
    expect(body.sessions[0]?.worktree).toEqual({ branch: "wt/chat-1" });
  });

  it("answers 404 for a project that is not this user's", async () => {
    mockGetProjectSettings.mockResolvedValue(null);

    const res = await GET(listRequest("?projectId=someone-elses"));

    expect(res.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("has no project header to name in the chat view", async () => {
    const res = await GET(listRequest());
    const body = (await res.json()) as { project: unknown };

    expect(mockGetProjectSettings).not.toHaveBeenCalled();
    expect(body.project).toBeNull();
  });

  it("marks a chat that is generating from the redis set", async () => {
    mockGetActiveSessions.mockResolvedValue(new Set(["chat-1"]));

    const res = await GET(listRequest("?projectId=project-1"));
    const body = (await res.json()) as { sessions: Array<{ isGenerating: boolean }> };

    expect(body.sessions[0]?.isGenerating).toBe(true);
  });

  it("returns the pin state and sorts pinned chats first", async () => {
    mockFindMany.mockResolvedValue([{ ...STORED_ROW, pinned: true }]);

    const res = await GET(listRequest());
    const args = mockFindMany.mock.calls[0]![0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([{ pinned: "desc" }, { lastActivityAt: "desc" }]);
    const body = (await res.json()) as { sessions: Array<{ pinned: boolean }> };
    expect(body.sessions[0]?.pinned).toBe(true);
  });
});

describe("POST /api/chat/sessions with a project", () => {
  it("stores the project on the new coder chat", async () => {
    mockOwnedProjectId.mockResolvedValue("project-1");

    const res = await POST(postRequest({ title: "Fix it", projectId: "project-1" }));

    expect(res.status).toBe(200);
    expect(mockOwnedProjectId).toHaveBeenCalledWith(USER, "project-1");
    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.projectId).toBe("project-1");
    expect(data.userId).toBe(USER);
  });

  it("answers 404 for another user's project and creates nothing", async () => {
    mockOwnedProjectId.mockResolvedValue(null);
    mockGetProjectSettings.mockResolvedValue(PROJECT);

    const res = await POST(postRequest({ title: "Fix it", projectId: "someone-elses" }));

    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a normal chat when no project is given", async () => {
    const res = await POST(postRequest({ title: "Just chatting" }));

    expect(res.status).toBe(200);
    expect(mockOwnedProjectId).not.toHaveBeenCalled();
    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.projectId).toBeUndefined();
  });
});
