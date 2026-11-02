import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    taskRun: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("bullmq", () => ({ Queue: vi.fn() }));

import { prisma } from "@/lib/db";
import { pruneTaskRuns, TASK_RUN_HISTORY_LIMIT } from "@/lib/queue";

const mockFindMany = vi.mocked(prisma.taskRun.findMany);
const mockDeleteMany = vi.mocked(prisma.taskRun.deleteMany);

/** A full window of kept runs, newest first. */
function keptRunIds(count = TASK_RUN_HISTORY_LIMIT): string[] {
  return Array.from({ length: count }, (_, i) => `run-${i}`);
}

/** The same ids in the shape Prisma returns for a `select: { id: true }` read. */
function keptRuns(count?: number): never[] {
  return keptRunIds(count).map((id) => ({ id })) as never[];
}

describe("pruneTaskRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("drops everything older than the newest runs of the task", async () => {
    mockFindMany.mockResolvedValue(keptRuns());

    await pruneTaskRuns("task-1");

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { taskId: "task-1" },
      orderBy: { createdAt: "desc" },
      take: TASK_RUN_HISTORY_LIMIT,
      select: { id: true },
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", id: { notIn: keptRunIds() } },
    });
  });

  it("deletes nothing while the task is below the limit", async () => {
    mockFindMany.mockResolvedValue(keptRuns(TASK_RUN_HISTORY_LIMIT - 1));

    await pruneTaskRuns("task-1");

    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
