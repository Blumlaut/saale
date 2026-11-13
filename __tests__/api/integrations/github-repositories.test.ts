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
    readGithubInstallationRepositories: vi.fn(),
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

import { GET } from "@/app/api/integrations/github/repositories/route";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";

const REPOSITORIES = {
  installationId: "1234",
  accountLogin: "acme",
  accountType: "Organization",
  selection: "selected",
  installed: [
    { id: "10", name: "saale", fullName: "acme/saale" },
    { id: "11", name: "web", fullName: "acme/web" },
  ],
};

function get(query: string): NextRequest {
  return new NextRequest(
    new URL(`/api/integrations/github/repositories${query}`, "http://localhost"),
  );
}

beforeEach(() => {
  mockRequireSession.mockReset();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER }, userId: USER });
  lib.readGithubInstallationRepositories.mockReset();
  lib.readGithubInstallationRepositories.mockResolvedValue(REPOSITORIES);
});

// ─── Reading the set ────────────────────────────────────────────────────────

describe("GET", () => {
  it("needs the installation it is about", async () => {
    const response = await GET(get(""));

    expect(response.status).toBe(400);
    expect(lib.readGithubInstallationRepositories).not.toHaveBeenCalled();
  });

  it("answers with the set the installation covers", async () => {
    const body = (await (await GET(get("?installation=1234"))).json()) as typeof REPOSITORIES;

    expect(lib.readGithubInstallationRepositories).toHaveBeenCalledWith(USER, "1234");
    expect(body.installed.map((entry) => entry.fullName)).toEqual(["acme/saale", "acme/web"]);
  });

  it("passes a refusal back as a 400", async () => {
    lib.readGithubInstallationRepositories.mockRejectedValue(
      new lib.GithubAppError("This account has no access to that GitHub installation."),
    );

    const response = await GET(get("?installation=9999"));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/no access/);
  });

  it("reports an unreachable GitHub as 502", async () => {
    lib.readGithubInstallationRepositories.mockRejectedValue(
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
    expect(lib.readGithubInstallationRepositories).not.toHaveBeenCalled();
  });
});
