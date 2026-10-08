import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The worker secret is read at module scope, so it must be set before import.
process.env.WORKER_API_KEY = "test-worker-secret";

vi.mock("@/lib/db", () => ({
  prisma: { scriptWatcher: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/queue", () => ({
  unscheduleWatcher: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/watchers/tick", () => ({
  runWatcherTick: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { unscheduleWatcher } from "@/lib/queue";
import { runWatcherTick } from "@/lib/watchers/tick";
import { POST } from "@/app/api/watchers/execute/route";
import type { TickOutcome } from "@/lib/watchers/tick";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findWatcher = vi.mocked(prisma.scriptWatcher.findUnique as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeRequest(watcherId?: string, key = "test-worker-secret") {
  return new NextRequest("http://localhost/api/watchers/execute", {
    method: "POST",
    headers: { "x-worker-key": key },
    body: JSON.stringify({ watcherId }),
  });
}

const IDLE: TickOutcome = { status: "idle", output: "", durationMs: 12, callCount: 0 };

describe("POST /api/watchers/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runWatcherTick).mockResolvedValue(IDLE);
  });

  it("refuses a request without the worker key", async () => {
    const response = await POST(makeRequest("w-1", ""));

    expect(response.status).toBe(401);
    expect(runWatcherTick).not.toHaveBeenCalled();
  });

  it("refuses a request with the wrong worker key", async () => {
    const response = await POST(makeRequest("w-1", "wrong-key"));

    expect(response.status).toBe(401);
    expect(runWatcherTick).not.toHaveBeenCalled();
  });

  it("rejects a tick with no watcher id", async () => {
    const response = await POST(makeRequest(undefined));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("watcherId is required");
  });

  it("runs the tick for an enabled watcher and reports its outcome", async () => {
    findWatcher.mockResolvedValue({ id: "w-1", enabled: true, userId: "u-1" });

    const response = await POST(makeRequest("w-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.outcome.status).toBe("idle");
    expect(runWatcherTick).toHaveBeenCalledWith("w-1");
    expect(unscheduleWatcher).not.toHaveBeenCalled();
  });

  it("stops the scheduler for a watcher that was deleted, instead of retrying forever", async () => {
    findWatcher.mockResolvedValue(null);

    const response = await POST(makeRequest("w-gone"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(runWatcherTick).not.toHaveBeenCalled();
    expect(unscheduleWatcher).toHaveBeenCalledWith("w-gone");
  });

  it("stops the scheduler for a watcher that is disabled", async () => {
    findWatcher.mockResolvedValue({ id: "w-1", enabled: false, userId: "u-1" });

    const response = await POST(makeRequest("w-1"));

    expect((await response.json()).skipped).toBe(true);
    expect(runWatcherTick).not.toHaveBeenCalled();
    expect(unscheduleWatcher).toHaveBeenCalledWith("w-1");
  });

  it("reports a failure that escaped the tick as a 500", async () => {
    findWatcher.mockResolvedValue({ id: "w-1", enabled: true, userId: "u-1" });
    vi.mocked(runWatcherTick).mockRejectedValue(new Error("database is down"));

    const response = await POST(makeRequest("w-1"));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("database is down");
  });
});
