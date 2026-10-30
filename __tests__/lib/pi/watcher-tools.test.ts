import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { scriptWatcher: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/queue", () => ({
  scheduleWatcher: vi.fn(async () => {}),
  syncWatcherSchedule: vi.fn(async () => {}),
  unscheduleWatcher: vi.fn(async () => {}),
}));

vi.mock("@/lib/watchers/tick", () => ({
  previewScript: vi.fn(),
  previewWatcherTick: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { createWatcherTools } from "@/lib/pi/tools/watcher-tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWatcher = prisma.scriptWatcher as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTool = (name: string): any => {
  const tool = createWatcherTools("user-1", "chat-1").find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = (tool: any, params: Record<string, unknown>) =>
  tool.execute("call-1", params, undefined, undefined, {} as never);

/** A stored watcher row, as Prisma returns it with session and project joined. */
const storedWatcher = (overrides: Record<string, unknown> = {}) => ({
  id: "w-1",
  userId: "user-1",
  name: "invoice watch",
  description: "looks for invoices",
  script: "const r = await tools.mail_search({ query: 'invoice' }); return r.count || undefined;",
  cronExpression: "*/10 * * * *",
  enabled: true,
  deliver: "chat",
  sessionId: "chat-1",
  projectId: null,
  worktreeMode: "per-fire",
  retentionMinutes: 1440,
  stickySessionId: null,
  wakePrompt: "Review the invoice and tell me what it is for.",
  modelId: "anthropic:claude-haiku-4-5",
  cooldownMinutes: 30,
  store: { lastSeen: "abc" },
  lastValue: '"2 new invoices"',
  lastTickAt: new Date("2026-02-01T10:00:00Z"),
  lastError: null,
  lastFiredAt: new Date("2026-02-01T10:00:00Z"),
  tickCount: 12,
  fireCount: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T10:00:00Z"),
  session: { title: "Inbox" },
  project: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockWatcher.findFirst.mockResolvedValue(storedWatcher());
});

describe("watcher_get", () => {
  it("returns the stored script and every setting a later edit has to preserve", async () => {
    const result = await callExecute(getTool("watcher_get"), { watcherId: "w-1" });

    expect(result.structuredContent).toEqual({
      id: "w-1",
      name: "invoice watch",
      description: "looks for invoices",
      script:
        "const r = await tools.mail_search({ query: 'invoice' }); return r.count || undefined;",
      cronExpression: "*/10 * * * *",
      enabled: true,
      deliver: "chat",
      sessionId: "chat-1",
      sessionTitle: "Inbox",
      projectId: null,
      projectName: null,
      worktreeMode: "per-fire",
      retentionMinutes: 1440,
      wakePrompt: "Review the invoice and tell me what it is for.",
      modelId: "anthropic:claude-haiku-4-5",
      cooldownMinutes: 30,
      ticks: 12,
      fires: 3,
      lastTickAt: "2026-02-01T10:00:00.000Z",
      lastFiredAt: "2026-02-01T10:00:00.000Z",
      lastError: null,
      lastValue: '"2 new invoices"',
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T10:00:00.000Z",
    });
  });

  it("only reads the caller's own watchers", async () => {
    mockWatcher.findFirst.mockResolvedValue(null);

    await expect(callExecute(getTool("watcher_get"), { watcherId: "w-1" })).rejects.toThrow(
      "Watcher not found",
    );
    expect(mockWatcher.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w-1", userId: "user-1" } }),
    );
  });
});
