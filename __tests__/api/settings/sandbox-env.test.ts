import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listNames: vi.fn(),
  setVar: vi.fn(),
  deleteVar: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: hoisted.requireSession }));

vi.mock("@/lib/sandbox/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox/env")>("@/lib/sandbox/env");
  return {
    ...actual,
    listSandboxEnvNames: hoisted.listNames,
    setSandboxEnvVar: hoisted.setVar,
    deleteSandboxEnvVar: hoisted.deleteVar,
  };
});

import { DELETE, GET, PUT } from "@/app/api/settings/sandbox-env/route";
import { SandboxEnvError } from "@/lib/sandbox/env";

const USER = "user-1";

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/settings/sandbox-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function remove(name: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/settings/sandbox-env?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.requireSession.mockResolvedValue({ ok: true, user: { id: USER } });
  hoisted.listNames.mockResolvedValue(["GH_TOKEN"]);
  hoisted.setVar.mockResolvedValue(undefined);
  hoisted.deleteVar.mockResolvedValue(true);
});

describe("GET /api/settings/sandbox-env", () => {
  it("returns names only, never a value", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ names: ["GH_TOKEN"] });
    expect(hoisted.listNames).toHaveBeenCalledWith(USER);
  });

  it("is scoped to the signed-in user", async () => {
    hoisted.requireSession.mockResolvedValue({ ok: true, user: { id: "user-2" } });

    await GET();

    expect(hoisted.listNames).toHaveBeenCalledWith("user-2");
  });

  it("refuses an unauthenticated read", async () => {
    hoisted.requireSession.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(hoisted.listNames).not.toHaveBeenCalled();
  });
});

describe("PUT /api/settings/sandbox-env", () => {
  it("stores a value for the signed-in user", async () => {
    const res = await put({ name: "GH_TOKEN", value: "ghp_secret" });

    expect(res.status).toBe(200);
    expect(hoisted.setVar).toHaveBeenCalledWith(USER, "GH_TOKEN", "ghp_secret");
    await expect(res.json()).resolves.toEqual({ names: ["GH_TOKEN"] });
  });

  it("rejects a body without a value", async () => {
    for (const body of [{ name: "GH_TOKEN" }, { name: "GH_TOKEN", value: "" }, {}, null]) {
      const res = await put(body);
      expect(res.status).toBe(400);
    }
    expect(hoisted.setVar).not.toHaveBeenCalled();
  });

  it("reports a refused name as a 400 with the rule", async () => {
    hoisted.setVar.mockRejectedValue(new SandboxEnvError("Variable names start with a letter"));

    const res = await put({ name: "gh token", value: "x" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Variable names start"),
    });
  });

  it("answers with the caller's own names, so one user cannot see another's", async () => {
    hoisted.requireSession.mockResolvedValue({ ok: true, user: { id: "user-2" } });
    hoisted.listNames.mockResolvedValue(["OTHER_TOKEN"]);

    const res = await put({ name: "GH_TOKEN", value: "x" });

    await expect(res.json()).resolves.toEqual({ names: ["OTHER_TOKEN"] });
    expect(hoisted.setVar).toHaveBeenCalledWith("user-2", "GH_TOKEN", "x");
  });
});

describe("DELETE /api/settings/sandbox-env", () => {
  it("removes one name for the signed-in user", async () => {
    const res = await remove("GH_TOKEN");

    expect(res.status).toBe(200);
    expect(hoisted.deleteVar).toHaveBeenCalledWith(USER, "GH_TOKEN");
    await expect(res.json()).resolves.toEqual({ names: ["GH_TOKEN"] });
  });

  it("404s a name this user does not have", async () => {
    hoisted.deleteVar.mockResolvedValue(false);

    const res = await remove("GH_TOKEN");

    expect(res.status).toBe(404);
  });

  it("400s a request without a name", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/settings/sandbox-env", { method: "DELETE" }),
    );

    expect(res.status).toBe(400);
    expect(hoisted.deleteVar).not.toHaveBeenCalled();
  });
});
