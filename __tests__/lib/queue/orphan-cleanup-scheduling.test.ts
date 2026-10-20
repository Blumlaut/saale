import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock queue instance  `getQueue()` must return the same instance
// every call so assertions can observe the scheduler calls.
const { mockUpsertJobScheduler, mockRemoveJobScheduler, mockGetJobSchedulers } = vi.hoisted(() => ({
  mockUpsertJobScheduler: vi.fn(),
  mockRemoveJobScheduler: vi.fn(),
  mockGetJobSchedulers: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      upsertJobScheduler: mockUpsertJobScheduler,
      removeJobScheduler: mockRemoveJobScheduler,
      getJobSchedulers: mockGetJobSchedulers,
    };
  }),
}));

import { scheduleOrphanCleanup } from "@/lib/queue";

describe("orphaned image cleanup scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockUpsertJobScheduler.mockResolvedValue({});
    mockRemoveJobScheduler.mockResolvedValue(true);
    mockGetJobSchedulers.mockResolvedValue([]);
  });

  it("registers the cleanup scheduler with the interval as a cron pattern", async () => {
    await scheduleOrphanCleanup(30);

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      "cleanup-orphaned-images",
      { pattern: "*/30 * * * *", tz: "UTC" },
      { name: "cleanup_orphaned_images", data: {} },
    );
  });

  it("honours a different cleanup interval", async () => {
    await scheduleOrphanCleanup(5);

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      "cleanup-orphaned-images",
      { pattern: "*/5 * * * *", tz: "UTC" },
      expect.objectContaining({ name: "cleanup_orphaned_images" }),
    );
  });

  it("removes the keyless v5 repeatable entry for the same job", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      // v5 wrote keyless repeatable jobs under an md5 key with no scheduler id
      { key: "9f2c1d7ab34e5f60718293a4b5c6d7e8", name: "cleanup_orphaned_images", id: null },
    ]);

    const removed = await scheduleOrphanCleanup(30);

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith("9f2c1d7ab34e5f60718293a4b5c6d7e8");
    expect(removed).toEqual(["9f2c1d7ab34e5f60718293a4b5c6d7e8"]);
    expect(mockUpsertJobScheduler).toHaveBeenCalled();
  });

  it("keeps the current scheduler and unrelated schedulers", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      {
        key: "cleanup-orphaned-images",
        name: "cleanup_orphaned_images",
        id: "cleanup-orphaned-images",
      },
      { key: "scheduled-job-1", name: "execute", id: "scheduled-job-1" },
      { key: "agent-scheduled-def-1", name: "agent_execute", id: "agent-scheduled-def-1" },
    ]);

    const removed = await scheduleOrphanCleanup(30);

    expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });

  it("is idempotent across restarts (nothing left to remove)", async () => {
    mockGetJobSchedulers.mockResolvedValue([
      {
        key: "cleanup-orphaned-images",
        name: "cleanup_orphaned_images",
        id: "cleanup-orphaned-images",
      },
    ]);

    await expect(scheduleOrphanCleanup(30)).resolves.toEqual([]);
    await expect(scheduleOrphanCleanup(30)).resolves.toEqual([]);
    expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
  });

  it("still registers the scheduler and logs when the scheduler list is unavailable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetJobSchedulers.mockRejectedValue(new Error("redis down"));

    await expect(scheduleOrphanCleanup(30)).resolves.toEqual([]);

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("cleanup_orphaned_images"),
      expect.any(Error),
    );
  });

  it("logs and keeps going when a legacy entry cannot be removed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetJobSchedulers.mockResolvedValue([
      { key: "legacy-key", name: "cleanup_orphaned_images", id: null },
    ]);
    mockRemoveJobScheduler.mockRejectedValue(new Error("no such scheduler"));

    await expect(scheduleOrphanCleanup(30)).resolves.toEqual([]);

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("legacy-key"), expect.any(Error));
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
  });
});
