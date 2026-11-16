import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRequireSession = vi.fn();
const mockList = vi.fn();
const mockInstall = vi.fn();
const mockRemove = vi.fn();
const mockEvict = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/skills/global", () => ({
  listGlobalSkills: (...args: unknown[]) => mockList(...args),
  installGlobalSkill: (...args: unknown[]) => mockInstall(...args),
  removeGlobalSkill: (...args: unknown[]) => mockRemove(...args),
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: (...args: unknown[]) => mockEvict(...args),
}));

import { GET, POST } from "@/app/api/skills/route";
import { DELETE } from "@/app/api/skills/[name]/route";

const USER_ID = "user-1";
const SKILL = {
  name: "sofa",
  description: "Stack Overflow for Agents",
  path: "/w/user-1/.agents/skills/sofa/SKILL.md",
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
});

describe("GET /api/skills", () => {
  it("lists the account's skills", async () => {
    mockList.mockResolvedValue([SKILL]);

    const response = await GET();

    expect(await response.json()).toEqual({ skills: [SKILL] });
    expect(mockList).toHaveBeenCalledWith(USER_ID);
  });

  it("answers with the auth refusal instead of reading anything", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("POST /api/skills", () => {
  it("installs a pasted skill and evicts the account's pooled chats", async () => {
    mockInstall.mockResolvedValue({ ok: true, skill: SKILL });

    const response = await POST(post({ markdown: "---\nname: sofa\n---\n\nBody" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ skill: SKILL });
    expect(mockInstall).toHaveBeenCalledWith(USER_ID, { markdown: "---\nname: sofa\n---\n\nBody" });
    expect(mockEvict).toHaveBeenCalledWith(USER_ID);
  });

  it("passes an address through to the install", async () => {
    mockInstall.mockResolvedValue({ ok: true, skill: SKILL });

    await POST(post({ url: "https://agents.stackoverflow.com/skill.md" }));

    expect(mockInstall).toHaveBeenCalledWith(USER_ID, {
      url: "https://agents.stackoverflow.com/skill.md",
    });
  });

  it("asks for a skill when the body has neither field", async () => {
    const response = await POST(post({}));

    expect(response.status).toBe(400);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("reports why a skill was refused", async () => {
    mockInstall.mockResolvedValue({
      ok: false,
      error: "The frontmatter needs a name.",
      status: 400,
    });

    const response = await POST(post({ markdown: "---\ndescription: x\n---\n\nBody" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The frontmatter needs a name." });
    expect(mockEvict).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/skills/:name", () => {
  it("removes a skill and evicts the account's pooled chats", async () => {
    mockRemove.mockResolvedValue(true);

    const response = await DELETE(new NextRequest("http://localhost/api/skills/sofa"), {
      params: Promise.resolve({ name: "sofa" }),
    });

    expect(response.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith(USER_ID, "sofa");
    expect(mockEvict).toHaveBeenCalledWith(USER_ID);
  });

  it("answers 404 for a name that is not installed", async () => {
    mockRemove.mockResolvedValue(false);

    const response = await DELETE(new NextRequest("http://localhost/api/skills/nope"), {
      params: Promise.resolve({ name: "nope" }),
    });

    expect(response.status).toBe(404);
    expect(mockEvict).not.toHaveBeenCalled();
  });
});
