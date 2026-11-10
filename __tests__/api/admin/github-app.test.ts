import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequirePermission = vi.fn();

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}));

const { db } = vi.hoisted(() => ({
  db: { githubUserToken: { count: vi.fn() }, githubInstallation: { count: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

const credentials = vi.hoisted(() => ({ readGithubTokenPrecedence: vi.fn() }));
vi.mock("@/lib/integrations/github-credentials", () => credentials);

const settings = vi.hoisted(() => ({ setSetting: vi.fn() }));
vi.mock("@/lib/settings/update", () => settings);

const app = vi.hoisted(() => {
  class GithubAppError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GithubAppError";
    }
  }
  return {
    GithubAppError,
    readGithubAppSummary: vi.fn(),
    saveGithubApp: vi.fn(),
    setGithubAppEnabled: vi.fn(),
    deleteGithubApp: vi.fn(),
  };
});

vi.mock("@/lib/integrations/github-app", () => ({
  GithubAppError: app.GithubAppError,
  readGithubAppSummary: app.readGithubAppSummary,
  saveGithubApp: app.saveGithubApp,
  setGithubAppEnabled: app.setGithubAppEnabled,
  deleteGithubApp: app.deleteGithubApp,
}));

import { DELETE, GET, PATCH, PUT } from "@/app/api/admin/github/app/route";

// ─── Helpers ────────────────────────────────────────────────────────────────

const SUMMARY = {
  appId: "4711",
  clientId: "client-abc",
  slug: "saale",
  name: "Saale",
  ownerLogin: "askguenther",
  permissions: { contents: "write" },
  enabled: true,
  updatedAt: new Date("2026-05-01T12:00:00Z"),
};

const CREDENTIALS = {
  appId: "4711",
  clientId: "client-abc",
  clientSecret: "secret",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
};

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest(new URL("/api/admin/github/app", "http://localhost"), {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/** Let the request through as an admin. */
function allowAdmin() {
  mockRequirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" }, userId: "admin-1" });
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  db.githubUserToken.count.mockResolvedValue(0);
  credentials.readGithubTokenPrecedence.mockResolvedValue("app");
  settings.setSetting.mockResolvedValue(undefined);
  db.githubInstallation.count.mockResolvedValue(0);
  for (const fn of [
    app.readGithubAppSummary,
    app.saveGithubApp,
    app.setGithubAppEnabled,
    app.deleteGithubApp,
  ]) {
    fn.mockReset();
  }
  allowAdmin();
});

// ─── Guard ──────────────────────────────────────────────────────────────────

describe("admin guard", () => {
  it("asks for the github grant on every verb", async () => {
    await GET();
    await PUT(request("PUT", CREDENTIALS));
    await PATCH(request("PATCH", { enabled: true }));
    await DELETE();

    expect(mockRequirePermission).toHaveBeenCalledTimes(4);
    for (const call of mockRequirePermission.mock.calls) {
      expect(call).toEqual(["admin", "github"]);
    }
  });

  it("answers with the refusal and touches nothing", async () => {
    mockRequirePermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await PUT(request("PUT", CREDENTIALS));

    expect(response.status).toBe(403);
    expect(app.saveGithubApp).not.toHaveBeenCalled();
  });
});

// ─── Reading ────────────────────────────────────────────────────────────────

describe("GET", () => {
  it("reports the saved app", async () => {
    app.readGithubAppSummary.mockResolvedValue(SUMMARY);

    const body = (await (await GET()).json()) as { app: typeof SUMMARY };

    expect(body.app.slug).toBe("saale");
  });

  it("is null when nothing is saved, and still says where the app belongs", async () => {
    app.readGithubAppSummary.mockResolvedValue(null);

    const body = (await (await GET()).json()) as {
      app: null;
      setupUrl: string;
      connectedAccounts: number;
    };

    expect(body.app).toBeNull();
    // The admin has to paste these into GitHub, so the answer carries them.
    expect(body.setupUrl).toMatch(/\/api\/integrations\/github\/installed$/);
    expect(body.connectedAccounts).toBe(0);
  });
});

// ─── Saving ─────────────────────────────────────────────────────────────────

describe("PUT", () => {
  it("stores the credentials GitHub accepted", async () => {
    app.saveGithubApp.mockResolvedValue(SUMMARY);

    const response = await PUT(request("PUT", CREDENTIALS));

    expect(response.status).toBe(200);
    expect(app.saveGithubApp).toHaveBeenCalledWith({ ...CREDENTIALS, adminUserId: "admin-1" });
  });

  it("refuses a body that is not JSON", async () => {
    const response = await PUT(request("PUT", "not json"));

    expect(response.status).toBe(400);
    expect(app.saveGithubApp).not.toHaveBeenCalled();
  });

  it("refuses a body that misses a field", async () => {
    const response = await PUT(request("PUT", { appId: "4711" }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/All four fields/);
    expect(app.saveGithubApp).not.toHaveBeenCalled();
  });

  it("passes GitHub's objection back as a 400", async () => {
    app.saveGithubApp.mockRejectedValue(
      new app.GithubAppError("GitHub refused these credentials: Bad credentials."),
    );

    const response = await PUT(request("PUT", CREDENTIALS));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/Bad credentials/);
  });

  it("reports a server-side failure as 502", async () => {
    app.saveGithubApp.mockRejectedValue(new Error("fetch failed"));

    const response = await PUT(request("PUT", CREDENTIALS));

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(/could not be reached/);
  });
});

// ─── Switching and removing ─────────────────────────────────────────────────

describe("PATCH", () => {
  it("needs an existing app", async () => {
    app.readGithubAppSummary.mockResolvedValue(null);

    const response = await PATCH(request("PATCH", { enabled: false }));

    expect(response.status).toBe(404);
    expect(app.setGithubAppEnabled).not.toHaveBeenCalled();
  });

  it("refuses a body without the switch", async () => {
    const response = await PATCH(request("PATCH", { on: true }));

    expect(response.status).toBe(400);
    expect(app.setGithubAppEnabled).not.toHaveBeenCalled();
  });

  it("sets which credential wins when an account keeps its own token", async () => {
    app.readGithubAppSummary.mockResolvedValue(SUMMARY);
    credentials.readGithubTokenPrecedence.mockResolvedValue("variable");

    const response = await PATCH(request("PATCH", { tokenPrecedence: "variable" }));
    const body = (await response.json()) as { tokenPrecedence: string };

    expect(response.status).toBe(200);
    // The registry is the write path, so the admin role is checked again there.
    expect(settings.setSetting).toHaveBeenCalledWith(
      "admin-1",
      "admin.githubTokenPrecedence",
      "variable",
    );
    expect(body.tokenPrecedence).toBe("variable");
  });

  it("refuses a body that asks for nothing", async () => {
    const response = await PATCH(request("PATCH", {}));

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("switches the app and answers with the new state", async () => {
    app.readGithubAppSummary
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce({ ...SUMMARY, enabled: false });

    const response = await PATCH(request("PATCH", { enabled: false }));
    const body = (await response.json()) as { app: { enabled: boolean } };

    expect(app.setGithubAppEnabled).toHaveBeenCalledWith(false);
    expect(body.app.enabled).toBe(false);
  });
});

describe("DELETE", () => {
  it("forgets the app", async () => {
    const response = await DELETE();

    expect(app.deleteGithubApp).toHaveBeenCalled();
    expect(await response.json()).toEqual({ app: null });
  });
});
