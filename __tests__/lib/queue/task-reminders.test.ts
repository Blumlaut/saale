import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockTask, mockRedis } = vi.hoisted(() => ({
  mockTask: { findMany: vi.fn(), updateMany: vi.fn() },
  mockRedis: { lpush: vi.fn(), ltrim: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: { task: mockTask } }));
vi.mock("@/lib/redis", () => ({ getRedis: () => mockRedis }));

const mockSendTelegramToUser = vi.fn();
vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramToUser: (...args: unknown[]) => mockSendTelegramToUser(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { handler } from "@/lib/queue/jobs/task-reminders";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";

/** A task due today, in the shape the handler selects. */
const dueToday = {
  id: "task-1",
  title: "Submit tax return",
  dueDate: new Date("2026-03-10T00:00:00.000Z"),
};

const dueTomorrow = {
  id: "task-2",
  title: "Call the dentist",
  dueDate: new Date("2026-03-11T00:00:00.000Z"),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("task_reminders handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T08:00:00.000Z"));
    mockTask.updateMany.mockResolvedValue({ count: 0 });
    mockRedis.lpush.mockResolvedValue(1);
    mockRedis.ltrim.mockResolvedValue("OK");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers reminders on Telegram when the user has it connected", async () => {
    mockTask.findMany.mockResolvedValue([dueToday, dueTomorrow]);
    mockSendTelegramToUser.mockResolvedValue({ ok: true, chatId: "119075844", label: "Jane" });

    const result = JSON.parse(await handler({ config: {}, userId }));

    expect(result).toEqual({ tasksScanned: 2, telegramSent: 2, notificationsSent: 0 });
    expect(mockSendTelegramToUser).toHaveBeenCalledWith({
      userId,
      content: "Task due today: Submit tax return\n\nDon't forget this task is due today!",
    });
    expect(mockSendTelegramToUser).toHaveBeenCalledWith({
      userId,
      content: "Task due tomorrow: Call the dentist\n\nThis task is due tomorrow.",
    });
    // Nothing goes to the in-app list when Telegram already reached them.
    expect(mockRedis.lpush).not.toHaveBeenCalled();
    expect(mockTask.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-1", "task-2"] }, userId },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it("falls back to an in-app notification when Telegram is not connected", async () => {
    mockTask.findMany.mockResolvedValue([dueToday]);
    mockSendTelegramToUser.mockResolvedValue({
      ok: false,
      reason: "not_configured",
      error: "No Telegram bot is connected.",
    });

    const result = JSON.parse(await handler({ config: {}, userId }));

    expect(result).toEqual({ tasksScanned: 1, telegramSent: 0, notificationsSent: 1 });
    expect(mockRedis.lpush).toHaveBeenCalledTimes(1);

    const [key, payload] = mockRedis.lpush.mock.calls[0] as [string, string];
    expect(key).toBe(`notifications:${userId}`);
    expect(JSON.parse(payload)).toMatchObject({
      type: "task_reminder",
      title: "Task due today: Submit tax return",
      data: { taskId: "task-1" },
      read: false,
    });

    // Never having connected Telegram is the expected path, not an error.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs and falls back when a connected channel drops the message", async () => {
    mockTask.findMany.mockResolvedValue([dueToday]);
    mockSendTelegramToUser.mockResolvedValue({
      ok: false,
      reason: "send_failed",
      error: "Forbidden: bot was blocked by the user",
    });

    const result = JSON.parse(await handler({ config: {}, userId }));

    expect(result).toEqual({ tasksScanned: 1, telegramSent: 0, notificationsSent: 1 });
    expect(mockRedis.lpush).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Telegram delivery failed"),
    );
  });

  it("does nothing when no task is due", async () => {
    mockTask.findMany.mockResolvedValue([]);

    const result = JSON.parse(await handler({ config: {}, userId }));

    expect(result).toEqual({ tasksScanned: 0, telegramSent: 0, notificationsSent: 0 });
    expect(mockSendTelegramToUser).not.toHaveBeenCalled();
    expect(mockRedis.lpush).not.toHaveBeenCalled();
    expect(mockTask.updateMany).not.toHaveBeenCalled();
  });

  it("scopes the task scan and the notifiedAt write to the user", async () => {
    mockTask.findMany.mockResolvedValue([]);

    await handler({ config: {}, userId: "user-2" });

    expect(mockTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "user-2" }) }),
    );
  });
});
