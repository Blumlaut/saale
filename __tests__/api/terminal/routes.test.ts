import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(async () => ({ ok: true, user: { id: "user-1" } })),
}));

vi.mock("@/lib/terminal/shell-sessions", () => ({
  ShellUnavailableError: class ShellUnavailableError extends Error {
    constructor(
      message: string,
      readonly status = 409,
    ) {
      super(message);
    }
  },
  MAX_SHELL_DIMENSION: 1000,
  startShell: vi.fn(async (_userId: string, target: string) => ({
    target,
    status: "open" as const,
    error: null,
    cols: 80,
    rows: 24,
  })),
  closeShell: vi.fn(() => true),
  shellAvailability: vi.fn(async () => ({ available: true, reason: null })),
  sendShellInput: vi.fn(() => true),
  resizeShell: vi.fn(() => true),
  attachShell: vi.fn(() => null),
}));

import { requireSession } from "@/lib/auth";
import {
  attachShell,
  closeShell,
  resizeShell,
  sendShellInput,
  ShellUnavailableError,
  startShell,
} from "@/lib/terminal/shell-sessions";
import {
  DELETE as deleteShell,
  GET as readShell,
  POST as openShell,
} from "@/app/api/terminal/route";
import { POST as sendInput } from "@/app/api/terminal/input/route";
import { POST as resizeTerminal } from "@/app/api/terminal/resize/route";
import { GET as followShell } from "@/app/api/terminal/stream/route";

function post(route: (request: NextRequest) => Promise<Response>, query: string, body?: unknown) {
  return route(
    new NextRequest(`http://localhost/api/terminal${query}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("GET /api/terminal", () => {
  it("says whether this workspace can have a shell", async () => {
    const response = await readShell(new NextRequest("http://localhost/api/terminal?target=user"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ available: true, reason: null });
  });
});

describe("POST /api/terminal", () => {
  it("refuses an unauthenticated caller", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await post(openShell, "?target=user");
    expect(response.status).toBe(401);
  });

  it("opens a shell for the target in the query", async () => {
    const response = await post(openShell, "?target=machine:m1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      shell: { target: "machine:m1", status: "open" },
    });
    expect(startShell).toHaveBeenCalledWith("user-1", "machine:m1");
  });

  it("passes on why a target has no shell", async () => {
    vi.mocked(startShell).mockRejectedValueOnce(
      new ShellUnavailableError("This deployment cannot run commands"),
    );

    const response = await post(openShell, "?target=user");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "This deployment cannot run commands",
    });
  });

  it("closes the shell it is told to", async () => {
    const response = await deleteShell(
      new NextRequest("http://localhost/api/terminal?target=user", { method: "DELETE" }),
    );

    await expect(response.json()).resolves.toEqual({ closed: true });
    expect(closeShell).toHaveBeenCalledWith("user-1", "user");
  });
});

describe("GET /api/terminal/stream", () => {
  it("ends the stream when there is no shell behind the target", async () => {
    vi.mocked(attachShell).mockReturnValueOnce(null);

    const response = await followShell(
      new NextRequest("http://localhost/api/terminal/stream?target=user"),
    );

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    // A reader with nothing to read waits on a proxy forever, so this closes.
    await expect(response.text()).resolves.toBe("");
  });

  it("sends what the shell printed before the reader arrived", async () => {
    const detach = vi.fn();
    vi.mocked(attachShell).mockImplementationOnce((_userId, target, listener) => {
      listener({ type: "output", text: "$ " });
      // What `attachShell` tells a reader of a shell that is already over.
      listener({ type: "closed", error: null });
      return {
        state: { target, status: "closed", error: null, cols: 80, rows: 24 },
        live: false,
        detach,
      };
    });

    const body = await (
      await followShell(new NextRequest("http://localhost/api/terminal/stream?target=user"))
    ).text();

    expect(body).toContain("event: output");
    expect(body).toContain('"text":"$ "');
    expect(body).toContain("event: closed");
  });
});

describe("POST /api/terminal/input", () => {
  it("types what the terminal collected", async () => {
    const response = await post(sendInput, "?target=user", { data: "ls\r" });

    expect(response.status).toBe(200);
    expect(sendShellInput).toHaveBeenCalledWith("user-1", "user", "ls\r");
  });

  it("refuses a body that is not keystrokes", async () => {
    const response = await post(sendInput, "?target=user", { data: 4 });

    expect(response.status).toBe(400);
  });

  it("says so when the shell is not running", async () => {
    vi.mocked(sendShellInput).mockReturnValueOnce(false);

    const response = await post(sendInput, "?target=user", { data: "ls\r" });
    expect(response.status).toBe(409);
  });
});

describe("POST /api/terminal/resize", () => {
  it("refuses a terminal size the sandbox would not take", async () => {
    const response = await post(resizeTerminal, "?target=user", { cols: 0, rows: 24 });

    expect(response.status).toBe(400);
    expect(resizeShell).not.toHaveBeenCalled();
  });

  it("tells the shell its new size", async () => {
    const response = await post(resizeTerminal, "?target=user", { cols: 120, rows: 40 });

    expect(response.status).toBe(200);
    expect(resizeShell).toHaveBeenCalledWith("user-1", "user", 120, 40);
  });
});
