import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    queueTask: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/queue", () => ({
  syncQueueTaskSchedule: vi.fn().mockResolvedValue(undefined),
  unscheduleQueueTask: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db";
import { syncQueueTaskSchedule, unscheduleQueueTask } from "@/lib/queue";
import {
  MAILBOX_REFRESH_CRON,
  createMailboxRefreshJob,
  setMailboxRefreshJobEnabled,
  deleteMailboxRefreshJob,
} from "@/lib/email/auto-sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTaskCreate = vi.mocked(prisma.queueTask.create as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTaskFindMany = vi.mocked(prisma.queueTask.findMany as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTaskUpdateMany = vi.mocked(prisma.queueTask.updateMany as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTaskDeleteMany = vi.mocked(prisma.queueTask.deleteMany as any);

const createdJob = {
  id: "job-1",
  type: "email_sync",
  enabled: true,
  modelId: null,
  config: JSON.stringify({ cronExpression: MAILBOX_REFRESH_CRON, accountId: "acc-1" }),
};

describe("Mailbox refresh auto-sync job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /* ── create ── */

  it("creates an every-minute email_sync job scoped to the account and schedules it", async () => {
    mockQueueTaskCreate.mockResolvedValue(createdJob);

    await createMailboxRefreshJob("user-1", "acc-1");

    expect(mockQueueTaskCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        name: "mailbox-refresh:acc-1",
        type: "email_sync",
        enabled: true,
        config: JSON.stringify({ cronExpression: MAILBOX_REFRESH_CRON, accountId: "acc-1" }),
      },
    });
    expect(syncQueueTaskSchedule).toHaveBeenCalledWith(createdJob);
    expect(unscheduleQueueTask).not.toHaveBeenCalled();
  });

  it("logs but does not throw when scheduling fails", async () => {
    mockQueueTaskCreate.mockResolvedValue(createdJob);
    vi.mocked(syncQueueTaskSchedule).mockRejectedValueOnce(new Error("redis down"));

    await expect(createMailboxRefreshJob("user-1", "acc-1")).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to schedule mailbox refresh job"),
      expect.any(Error),
    );
  });

  /* ── enable/disable ── */

  it("disables the job and resyncs its schedule", async () => {
    mockQueueTaskUpdateMany.mockResolvedValue({ count: 1 });
    mockQueueTaskFindMany.mockResolvedValue([
      { id: "job-1", type: "email_sync", enabled: false, modelId: null, config: "{}" },
    ]);

    await setMailboxRefreshJobEnabled("user-1", "acc-1", false);

    expect(mockQueueTaskUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", name: "mailbox-refresh:acc-1" },
      data: { enabled: false },
    });
    expect(syncQueueTaskSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", enabled: false }),
    );
  });

  it("does not resync when no job exists for the account", async () => {
    mockQueueTaskUpdateMany.mockResolvedValue({ count: 0 });

    await setMailboxRefreshJobEnabled("user-1", "acc-1", false);

    expect(syncQueueTaskSchedule).not.toHaveBeenCalled();
  });

  /* ── delete ── */

  it("unschedules and deletes the job scoped to the user", async () => {
    mockQueueTaskFindMany.mockResolvedValue([{ id: "job-1" }]);
    mockQueueTaskDeleteMany.mockResolvedValue({ count: 1 });

    await deleteMailboxRefreshJob("user-1", "acc-1");

    expect(mockQueueTaskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );
    expect(unscheduleQueueTask).toHaveBeenCalledWith("job-1");
    expect(mockQueueTaskDeleteMany).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1" },
    });
  });

  it("does nothing when no auto-sync job exists", async () => {
    mockQueueTaskFindMany.mockResolvedValue([]);

    await deleteMailboxRefreshJob("user-1", "acc-1");

    expect(unscheduleQueueTask).not.toHaveBeenCalled();
    expect(mockQueueTaskDeleteMany).not.toHaveBeenCalled();
  });
});
