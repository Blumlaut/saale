import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

const lib = vi.hoisted(() => {
  class GithubAppError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GithubAppError";
    }
  }
  return {
    GithubAppError,
    readGithubRepositoryChoices: vi.fn(),
    applyGithubRepositoryChoices: vi.fn(),
  };
});
vi.mock("@/lib/integrations/github-app", () => lib);

const client = vi.hoisted(() => {
  class GithubApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "GithubApiError";
    }
  }
  return { GithubApiError };
});
vi.mock("@/lib/integrations/github-app-client", () => client);

import { GET, PUT } from "@/app/api/integrations/github/repositories/route";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";

const CHOICES = {
  installationId: "1234",
  accountLogin: "acme",
  selection: "selected",
  canManage: true,
  installed: [{ id: "10", name: "saale", fullName: "acme/saale" }],
  candidates: [
    { id: "10", fullName: "acme/saale", installed: true },
    { id: "11", fullName: "acme/web", installed: false },
  ],
};

function get(query: string): NextRequest {
  return new NextRequest(
    new URL(`/api/integrations/github/repositories${query}`, "http://localhost"),
  );
}

function put(body: unknown): NextRequest {
  return new NextRequest(new URL("/api/integrations/github/repositories", "http://localhost"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRequireSession.mockReset();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER }, userId: USER });
  lib.readGithubRepositoryChoices.mockReset();
  lib.applyGithubRepositoryChoices.mockReset();
  lib.readGithubRepositoryChoices.mockResolvedValue(CHOICES);
  lib.applyGithubRepositoryChoices.mockResolvedValue(CHOICES);
});

// ─── Reading the set ────────────────────────────────────────────────────────

describe("GET", () => {
  it("needs the installation it is about", async () => {
    const response = await GET(get(""));

    expect(response.status).toBe(400);
    expect(lib.readGithubRepositoryChoices).not.toHaveBeenCalled();
  });

  it("answers with the installed repositories and the candidates", async () => {
    const body = (await (await GET(get("?installation=1234"))).json()) as typeof CHOICES;

    expect(lib.readGithubRepositoryChoices).toHaveBeenCalledWith(USER, "1234");
    expect(body.canManage).toBe(true);
    expect(body.candidates.map((entry) => entry.fullName)).toEqual(["acme/saale", "acme/web"]);
  });

  it("passes a refusal back as a 400", async () => {
    lib.readGithubRepositoryChoices.mockRejectedValue(
      new lib.GithubAppError("This account has no access to that GitHub installation."),
    );

    const response = await GET(get("?installation=9999"));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/no access/);
  });

  it("reports an unreachable GitHub as 502", async () => {
    lib.readGithubRepositoryChoices.mockRejectedValue(
      new client.GithubApiError("The installation timed out", 0),
    );

    const response = await GET(get("?installation=1234"));

    expect(response.status).toBe(502);
  });

  it("needs a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET(get("?installation=1234"));

    expect(response.status).toBe(401);
    expect(lib.readGithubRepositoryChoices).not.toHaveBeenCalled();
  });
});

// ─── Changing the set ───────────────────────────────────────────────────────

describe("PUT", () => {
  it("applies the selection it is given", async () => {
    const body = (await (
      await PUT(put({ installationId: "1234", repositoryIds: ["11"] }))
    ).json()) as {
      installationId: string;
    };

    expect(lib.applyGithubRepositoryChoices).toHaveBeenCalledWith(USER, "1234", ["11"]);
    expect(body.installationId).toBe("1234");
  });

  it("refuses a body that is not JSON", async () => {
    const response = await PUT(put("not json"));

    expect(response.status).toBe(400);
    expect(lib.applyGithubRepositoryChoices).not.toHaveBeenCalled();
  });

  it("refuses a body without the ids", async () => {
    const response = await PUT(put({ installationId: "1234" }));

    expect(response.status).toBe(400);
    expect(lib.applyGithubRepositoryChoices).not.toHaveBeenCalled();
  });

  it("explains an installation that covers everything", async () => {
    lib.applyGithubRepositoryChoices.mockRejectedValue(
      new lib.GithubAppError(
        "This installation covers all repositories. Switch it to “Only select repositories” on GitHub first, then choose here.",
      ),
    );

    const response = await PUT(put({ installationId: "1234", repositoryIds: [] }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Only select repositories/,
    );
  });

  it("passes GitHub's refusal through with its own wording", async () => {
    lib.applyGithubRepositoryChoices.mockRejectedValue(new client.GithubApiError("Not Found", 404));

    const response = await PUT(put({ installationId: "1234", repositoryIds: ["11"] }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/Not Found/);
  });
});
