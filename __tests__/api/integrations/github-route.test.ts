import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

const cli = vi.hoisted(() => ({
  githubStatus: vi.fn(),
  startGithubLogin: vi.fn(),
  signOutGithub: vi.fn(),
}));
vi.mock("@/lib/coder/github", () => cli);

const app = vi.hoisted(() => {
  class GithubAppError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GithubAppError";
    }
  }
  return {
    GithubAppError,
    forgetGithubAppLogin: vi.fn(),
    pollGithubAppLogin: vi.fn(),
    readGithubAppCredentials: vi.fn(),
    readGithubAppStatus: vi.fn(),
    signOutGithubApp: vi.fn(),
    startGithubAppLogin: vi.fn(),
  };
});
vi.mock("@/lib/integrations/github-app", () => app);

import { DELETE, GET, POST } from "@/app/api/integrations/github/route";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";
const IDLE_CLI = { credential: null, pending: null, error: null };

const AUTHORIZED_APP = {
  configured: true,
  authorized: { login: "octocat", expiresAt: new Date("2026-05-01T20:00:00Z") },
  installations: [
    {
      installationId: "1234",
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: ["saale"],
      suspended: false,
    },
  ],
};

function url(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost"));
}

beforeEach(() => {
  mockRequireSession.mockReset();
  for (const fn of Object.values(cli)) fn.mockReset();
  for (const fn of Object.values(app)) {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }

  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER }, userId: USER });
  cli.githubStatus.mockResolvedValue(IDLE_CLI);
  app.readGithubAppCredentials.mockResolvedValue({ appId: "1", enabled: true, slug: "saale" });
  app.pollGithubAppLogin.mockResolvedValue({ state: "idle" });
  app.readGithubAppStatus.mockResolvedValue({ ...AUTHORIZED_APP });
});

// ─── Reading both sources ───────────────────────────────────────────────────

describe("GET", () => {
  it("reports the app and the CLI side by side", async () => {
    cli.githubStatus.mockResolvedValue({
      credential: {
        host: "github.com",
        login: "cli-user",
        scopes: null,
        gitProtocol: null,
        source: "gh",
      },
      pending: null,
      error: null,
    });

    const body = (await (await GET()).json()) as {
      app: { configured: boolean; authorized: { login: string; expiresAt: string } | null };
      cli: { credential: { login: string } | null };
    };

    expect(body.app.configured).toBe(true);
    expect(body.app.authorized?.login).toBe("octocat");
    // The date is serialized for the browser, not left as a Date.
    expect(body.app.authorized?.expiresAt).toBe("2026-05-01T20:00:00.000Z");
    expect(body.cli.credential?.login).toBe("cli-user");
  });

  it("reports no app when the instance has none, and never polls", async () => {
    app.readGithubAppCredentials.mockResolvedValue(null);

    const body = (await (await GET()).json()) as { app: { configured: boolean } };

    expect(body.app.configured).toBe(false);
    expect(app.pollGithubAppLogin).not.toHaveBeenCalled();
  });

  it("folds a pending sign-in into the answer", async () => {
    const expiresAt = new Date("2026-05-01T12:15:00Z");
    app.pollGithubAppLogin.mockResolvedValue({
      state: "pending",
      login: {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresAt,
      },
    });

    const body = (await (await GET()).json()) as {
      app: { pending: { userCode: string; expiresAt: string } | null };
    };

    expect(body.app.pending).toEqual({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: expiresAt.toISOString(),
    });
  });
});

// ─── Starting a sign-in ─────────────────────────────────────────────────────

describe("POST", () => {
  it("starts the app's flow when the instance has one", async () => {
    app.startGithubAppLogin.mockResolvedValue({
      userCode: "B893-BB4A",
      verificationUri: "https://github.com/login/device",
      expiresAt: new Date("2026-05-01T12:15:00Z"),
    });

    const body = (await (await POST()).json()) as {
      app: { pending: { userCode: string } | null };
    };

    expect(app.startGithubAppLogin).toHaveBeenCalledWith(USER);
    expect(cli.startGithubLogin).not.toHaveBeenCalled();
    expect(body.app.pending?.userCode).toBe("B893-BB4A");
  });

  it("keeps the GitHub CLI flow on an instance without an app", async () => {
    app.readGithubAppCredentials.mockResolvedValue(null);
    cli.startGithubLogin.mockResolvedValue({
      credential: null,
      pending: { code: "1B47-ABE8", url: "https://github.com/login/device" },
      error: null,
    });

    const body = (await (await POST()).json()) as {
      app: { configured: boolean };
      cli: { pending: { code: string } | null };
    };

    expect(cli.startGithubLogin).toHaveBeenCalledWith(USER);
    expect(app.startGithubAppLogin).not.toHaveBeenCalled();
    expect(body.app.configured).toBe(false);
    expect(body.cli.pending?.code).toBe("1B47-ABE8");
  });

  it("passes a refusal back as a 400", async () => {
    app.startGithubAppLogin.mockRejectedValue(
      new app.GithubAppError("The GitHub App is switched off on this instance."),
    );

    const response = await POST();

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/switched off/);
  });
});

// ─── Closing and signing out ────────────────────────────────────────────────

describe("DELETE", () => {
  it("cancels a code without signing anyone out", async () => {
    const response = await DELETE(url("/api/integrations/github?cancel=1"));

    expect(response.status).toBe(200);
    expect(app.forgetGithubAppLogin).toHaveBeenCalledWith(USER);
    expect(app.signOutGithubApp).not.toHaveBeenCalled();
    expect(cli.signOutGithub).not.toHaveBeenCalled();
  });

  it("signs out of the app", async () => {
    await DELETE(url("/api/integrations/github?source=app"));

    expect(app.signOutGithubApp).toHaveBeenCalledWith(USER);
    expect(cli.signOutGithub).not.toHaveBeenCalled();
  });

  it("still reaches the CLI sign-out when asked for it", async () => {
    await DELETE(url("/api/integrations/github?source=cli"));

    expect(cli.signOutGithub).toHaveBeenCalledWith(USER);
    expect(app.signOutGithubApp).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await DELETE(url("/api/integrations/github?source=app"));

    expect(response.status).toBe(401);
    expect(app.signOutGithubApp).not.toHaveBeenCalled();
  });
});
