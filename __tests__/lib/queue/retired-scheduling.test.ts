import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRemoveJobScheduler, mockGetJobSchedulers } = vi.hoisted(() => ({
  mockRemoveJobScheduler: vi.fn(),
  mockGetJobSchedulers: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      removeJobScheduler: mockRemoveJobScheduler,
      getJobSchedulers: mockGetJobSchedulers,
    };
  }),
}));

import { removeRetiredSchedulers } from "@/lib/queue";

describe("retired job schedulers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockRemoveJobScheduler.mockResolvedValue(true);
    mockGetJobSchedulers.mockResolvedValue([]);
  });

  it("removes the schedulers the deleted agent definitions left behind", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      { key: "agent-scheduled-def-1", name: "agent_execute", id: "agent-scheduled-def-1" },
      { key: "agent-scheduled-def-2", name: "agent_execute", id: "agent-scheduled-def-2" },
      { key: "watcher-scheduled-w1", name: "watcher_tick", id: "watcher-scheduled-w1" },
      {
        key: "cleanup-orphaned-images",
        name: "cleanup_orphaned_images",
        id: "cleanup-orphaned-images",
      },
    ]);

    const removed = await removeRetiredSchedulers();

    expect(removed).toEqual(["agent-scheduled-def-1", "agent-scheduled-def-2"]);
    expect(mockRemoveJobScheduler).toHaveBeenCalledTimes(2);
  });

  it("removes the council sweep its feature left behind", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      { key: "council-run-sweep", name: "council_sweep", id: "council-run-sweep" },
      { key: "calendar-reminders", name: "calendar_reminders", id: "calendar-reminders" },
    ]);

    await expect(removeRetiredSchedulers()).resolves.toEqual(["council-run-sweep"]);
    expect(mockRemoveJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("leaves the current schedulers alone", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      { key: "scheduled-job-1", name: "execute", id: "scheduled-job-1" },
      { key: "calendar-reminders", name: "calendar_reminders", id: "calendar-reminders" },
    ]);

    await expect(removeRetiredSchedulers()).resolves.toEqual([]);
    expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
  });

  it("removes nothing but logs when the scheduler list is unavailable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetJobSchedulers.mockRejectedValue(new Error("redis down"));

    await expect(removeRetiredSchedulers()).resolves.toEqual([]);

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("retired job"),
      expect.any(Error),
    );
  });

  it("logs and keeps going when one scheduler cannot be removed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetJobSchedulers.mockResolvedValue([
      { key: "agent-scheduled-def-1", name: "agent_execute", id: "agent-scheduled-def-1" },
      { key: "agent-scheduled-def-2", name: "agent_execute", id: "agent-scheduled-def-2" },
    ]);
    mockRemoveJobScheduler.mockRejectedValueOnce(new Error("no such scheduler"));

    await expect(removeRetiredSchedulers()).resolves.toEqual(["agent-scheduled-def-2"]);

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("agent-scheduled-def-1"),
      expect.any(Error),
    );
  });
});
