import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ScriptWatcher } from "@prisma/client";

/**
 * A tick end to end, with the real sandbox and a mocked database.
 *
 * The cases that matter are the ones where a tick must *not* wake the agent
 * a predicate that matched nothing, a cooldown still running, a script the user
 * has not approved  plus the one where the wake itself fails, because that is
 * where a report can be silently lost.
 */

const echoTool: ToolDefinition = {
  name: "mail_list",
  label: "List mail",
  description: "List mail",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text" as const, text: "one-message" }],
    details: undefined,
  }),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    scriptWatcher: { findUnique: vi.fn(), update: vi.fn() },
    scriptWatcherTick: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/watchers/access", () => ({
  loadWatcherToolAccess: vi.fn(),
}));

vi.mock("@/lib/watchers/wake", () => ({
  wakeAgent: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { loadWatcherToolAccess } from "@/lib/watchers/access";
import { wakeAgent } from "@/lib/watchers/wake";
import { runWatcherTick, previewScript } from "@/lib/watchers/tick";
import { hashScript } from "@/lib/watchers/grant";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findWatcher = vi.mocked(prisma.scriptWatcher.findUnique as any);
const updateWatcher = vi.mocked(prisma.scriptWatcher.update as any);
const createTick = vi.mocked(prisma.scriptWatcherTick.create as any);
const findTicks = vi.mocked(prisma.scriptWatcherTick.findMany as any);
const access = vi.mocked(loadWatcherToolAccess as any);
const wake = vi.mocked(wakeAgent as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A stored watcher, with the grant its script earns by default. */
function watcher(overrides: Partial<ScriptWatcher> = {}): ScriptWatcher {
  const script = "return await tools.mail_list({});";
  return {
    id: "w-1",
    userId: "u-1",
    name: "Watch the inbox",
    description: null,
    script,
    scriptHash: hashScript(script),
    grantedTools: [],
    grantAll: false,
    cronExpression: "*/5 * * * *",
    enabled: true,
    sessionId: "chat-1",
    wakePrompt: "Tell me about it.",
    modelId: null,
    store: {},
    lastValue: null,
    lastTickAt: null,
    lastError: null,
    lastFiredAt: null,
    tickCount: 0,
    fireCount: 0,
    cooldownMinutes: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** The data of the tick row written, if one was. */
function writtenTick(): Record<string, unknown> | undefined {
  return createTick.mock.calls[0]?.[0]?.data;
}

/** The data of the watcher update applied, if one was. */
function writtenUpdate(): Record<string, unknown> | undefined {
  return updateWatcher.mock.calls[0]?.[0]?.data;
}

describe("runWatcherTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.mockResolvedValue({
      callable: [echoTool],
      callableNames: ["mail_list"],
      toolPolicies: null,
    });
    findTicks.mockResolvedValue([]);
    updateWatcher.mockResolvedValue(watcher());
  });

  it("records an idle tick when the script has nothing to report", async () => {
    findWatcher.mockResolvedValue(
      watcher({ script: "return undefined;", scriptHash: hashScript("return undefined;") }),
    );

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("idle");
    expect(wake).not.toHaveBeenCalled();
    expect(writtenTick()?.status).toBe("idle");
    expect(writtenUpdate()?.tickCount).toEqual({ increment: 1 });
  });

  it("wakes the agent with the script's value and counts the fire", async () => {
    findWatcher.mockResolvedValue(watcher());

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("fired");
    expect(outcome.value).toBe("one-message");
    expect(wake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        name: "Watch the inbox",
        sessionId: "chat-1",
        value: "one-message",
      }),
    );
    expect(writtenUpdate()?.fireCount).toEqual({ increment: 1 });
    expect(writtenUpdate()?.lastFiredAt).toBeInstanceOf(Date);
  });

  it("carries the script's store into the next tick", async () => {
    findWatcher.mockResolvedValue(
      watcher({
        script: "store('count', (load('count') ?? 0) + 1);\nreturn undefined;",
        scriptHash: hashScript("store('count', (load('count') ?? 0) + 1);\nreturn undefined;"),
        store: { count: 2 },
      }),
    );

    await runWatcherTick("w-1");

    expect(writtenUpdate()?.store).toEqual({ count: 3 });
  });

  it("refuses a script that changed after it was approved, without running it or waking anyone", async () => {
    findWatcher.mockResolvedValue(
      watcher({ script: "return await tools.mail_list({});\n// edited after approval" }),
    );

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("changed after it was approved");
    expect(wake).not.toHaveBeenCalled();
    // The refusal is on the record, but the ledger did not move.
    expect(writtenTick()?.status).toBe("blocked");
    expect(writtenUpdate()?.store).toBeUndefined();
  });

  it("records a failed script as an error tick", async () => {
    findWatcher.mockResolvedValue(
      watcher({
        script: "throw new Error('boom');",
        scriptHash: hashScript("throw new Error('boom');"),
      }),
    );

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("error");
    expect(outcome.reason).toContain("boom");
    expect(wake).not.toHaveBeenCalled();
    expect(writtenUpdate()?.lastError).toContain("boom");
  });

  it("drops a fire that lands inside the cooldown, keeping the ledger moving", async () => {
    const script = "store('last', 'news');\nreturn 'news';";
    const lastFiredAt = new Date(Date.now() - 60_000);
    findWatcher.mockResolvedValue(
      watcher({ script, scriptHash: hashScript(script), cooldownMinutes: 30, lastFiredAt }),
    );

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("cooldown");
    expect(wake).not.toHaveBeenCalled();
    expect(writtenTick()?.status).toBe("cooldown");
    // The change was seen and dropped by design, so the ledger moves with it
    // otherwise the same burst would be delivered once the window opened.
    expect(writtenUpdate()?.store).toEqual({ last: "news" });
    expect(writtenUpdate()?.fireCount).toBeUndefined();
  });

  it("fires once the cooldown has passed", async () => {
    const script = "return 'news';";
    findWatcher.mockResolvedValue(
      watcher({
        script,
        scriptHash: hashScript(script),
        cooldownMinutes: 30,
        lastFiredAt: new Date(Date.now() - 31 * 60_000),
      }),
    );

    expect((await runWatcherTick("w-1")).status).toBe("fired");
  });

  it("keeps the report pending when the wake cannot be delivered", async () => {
    findWatcher.mockResolvedValue(watcher({ store: { seen: ["a"] } }));
    wake.mockRejectedValue(new Error('Chat "Inbox" is busy  try again once it is idle'));

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("busy");
    // Not fired, and  the point  the ledger did not move past a report the
    // user never received, so the next tick reports it again.
    expect(writtenUpdate()?.fireCount).toBeUndefined();
    expect(writtenUpdate()?.store).toBeUndefined();
  });

  it("does nothing for a watcher that is disabled or gone", async () => {
    findWatcher.mockResolvedValue(null);

    const outcome = await runWatcherTick("w-1");

    expect(outcome.status).toBe("blocked");
    expect(createTick).not.toHaveBeenCalled();
    expect(updateWatcher).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("previewScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.mockResolvedValue({
      callable: [echoTool],
      callableNames: ["mail_list"],
      toolPolicies: null,
    });
  });

  it("reports what a draft script returns without touching the database", async () => {
    const outcome = await previewScript({
      userId: "u-1",
      script: "return await tools.mail_list({});",
    });

    expect(outcome.status).toBe("fired");
    expect(outcome.value).toBe("one-message");
    expect(createTick).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("reports a draft script that declines to report", async () => {
    const outcome = await previewScript({ userId: "u-1", script: "return undefined;" });

    expect(outcome.status).toBe("idle");
    expect(createTick).not.toHaveBeenCalled();
  });

  it("reports a draft script's failure with its partial output", async () => {
    const outcome = await previewScript({
      userId: "u-1",
      script: "text('checked 3 folders');\nthrow new Error('bad selector');",
    });

    expect(outcome.status).toBe("error");
    expect(outcome.reason).toContain("bad selector");
    expect(outcome.output).toContain("checked 3 folders");
  });
});
