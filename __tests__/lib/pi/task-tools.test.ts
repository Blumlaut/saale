import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma — $queryRaw is needed for the full-text search path
vi.mock("@/lib/db", () => ({
  prisma: {
    task: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

// Import mocks for assertions
import * as db from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTask = db.prisma.task as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueryRaw = db.prisma.$queryRaw as any;

// Import after mocks
import { createTaskTools } from "@/lib/pi/tools/task-tools";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

// Factory to create a task record
function makeTask(overrides = {}) {
  return {
    id: "task-1",
    userId: "user-123",
    title: "Buy groceries",
    description: "Milk, eggs, bread",
    status: "pending",
    priority: "medium",
    dueDate: null,
    tags: ["shopping"],
    order: 0,
    source: "chat",
    sourceEmailId: null,
    completedAt: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

describe("createTaskTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all expected tool names", () => {
    const tools = createTaskTools(userId);
    const names = tools.map((t) => t.name);
    expect(names).toContain("task_create");
    expect(names).toContain("task_update");
    expect(names).toContain("task_list_pending");
    expect(names).toContain("task_search");
    expect(names).toContain("task_delete");
  });

  describe("task_create", () => {
    it("creates a task with defaults", async () => {
      const tools = createTaskTools(userId);
      const create = tools.find((t) => t.name === "task_create")!;

      const task = makeTask();
      mockTask.create.mockResolvedValue(task);
      mockTask.findMany.mockResolvedValue([]);

      const result = await callExecute(create.execute, { title: "Buy groceries" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.created).toBe(true);
      expect(text.task.title).toBe("Buy groceries");
      expect(text.task.priority).toBe("medium");
      expect(text.task.source).toBe("chat");
    });

    it("includes custom priority and dueDate", async () => {
      const tools = createTaskTools(userId);
      const create = tools.find((t) => t.name === "task_create")!;

      const task = makeTask({ priority: "high", dueDate: new Date("2025-07-15") });
      mockTask.create.mockResolvedValue(task);
      mockTask.findMany.mockResolvedValue([]);

      const result = await callExecute(create.execute, {
        title: "Deploy app",
        priority: "high",
        dueDate: "2025-07-15",
      });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.task.priority).toBe("high");
      expect(text.task.dueDate).toBe("2025-07-15T00:00:00.000Z");
    });

    it("warns about duplicate pending tasks", async () => {
      const tools = createTaskTools(userId);
      const create = tools.find((t) => t.name === "task_create")!;

      const task = makeTask();
      mockTask.create.mockResolvedValue(task);
      mockTask.findMany.mockResolvedValue([{ id: "task-dup", title: "Buy groceries in bulk" }]);

      const result = await callExecute(create.execute, { title: "Buy groceries" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.duplicates).toHaveLength(1);
      expect(text.duplicates[0].id).toBe("task-dup");
    });
  });

  describe("task_update", () => {
    it("updates task fields", async () => {
      const tools = createTaskTools(userId);
      const update = tools.find((t) => t.name === "task_update")!;

      const existing = makeTask();
      const updated = makeTask({ title: "Updated title", priority: "high" });
      mockTask.findFirst.mockResolvedValue(existing);
      mockTask.update.mockResolvedValue(updated);

      const result = await callExecute(update.execute, {
        taskId: "task-1",
        title: "Updated title",
        priority: "high",
      });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.updated).toBe(true);
      expect(text.task.title).toBe("Updated title");
    });

    it("sets completedAt when marking as completed", async () => {
      const tools = createTaskTools(userId);
      const update = tools.find((t) => t.name === "task_update")!;

      const existing = makeTask();
      const updated = makeTask({ status: "completed", completedAt: new Date() });
      mockTask.findFirst.mockResolvedValue(existing);
      mockTask.update.mockResolvedValue(updated);

      await callExecute(update.execute, { taskId: "task-1", status: "completed" });

      expect(mockTask.update).toHaveBeenCalledWith({
        where: { id: "task-1" },
        data: expect.objectContaining({
          status: "completed",
          completedAt: expect.any(Date),
        }),
      });
    });

    it("clears completedAt when marking as pending", async () => {
      const tools = createTaskTools(userId);
      const update = tools.find((t) => t.name === "task_update")!;

      const existing = makeTask({ status: "completed", completedAt: new Date() });
      const updated = makeTask({ status: "pending", completedAt: null });
      mockTask.findFirst.mockResolvedValue(existing);
      mockTask.update.mockResolvedValue(updated);

      await callExecute(update.execute, { taskId: "task-1", status: "pending" });

      expect(mockTask.update).toHaveBeenCalledWith({
        where: { id: "task-1" },
        data: expect.objectContaining({
          status: "pending",
          completedAt: null,
        }),
      });
    });

    it("throws when task not found", async () => {
      const tools = createTaskTools(userId);
      const update = tools.find((t) => t.name === "task_update")!;

      mockTask.findFirst.mockResolvedValue(null);

      await expect(
        callExecute(update.execute, { taskId: "nonexistent", title: "New title" }),
      ).rejects.toThrow("Task nonexistent not found");
    });
  });

  describe("task_list_pending", () => {
    it("returns pending tasks sorted by due date", async () => {
      const tools = createTaskTools(userId);
      const list = tools.find((t) => t.name === "task_list_pending")!;

      const tasks = [makeTask({ id: "task-1" }), makeTask({ id: "task-2", title: "Task 2" })];
      mockTask.findMany.mockResolvedValue(tasks);

      const result = await callExecute(list.execute, {});
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(2);
      expect(text.tasks).toHaveLength(2);
      expect(mockTask.findMany).toHaveBeenCalledWith({
        where: { userId, status: "pending" },
        orderBy: expect.arrayContaining([{ dueDate: expect.any(Object) }]),
        take: 50,
      });
    });

    it("respects custom limit", async () => {
      const tools = createTaskTools(userId);
      const list = tools.find((t) => t.name === "task_list_pending")!;

      mockTask.findMany.mockResolvedValue([]);

      await callExecute(list.execute, { limit: 10 });

      expect(mockTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
    });

    it("caps limit at 200", async () => {
      const tools = createTaskTools(userId);
      const list = tools.find((t) => t.name === "task_list_pending")!;

      mockTask.findMany.mockResolvedValue([]);

      await callExecute(list.execute, { limit: 9999 });

      expect(mockTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    });
  });

  describe("task_search", () => {
    it("uses full-text search when query is provided", async () => {
      const tools = createTaskTools(userId);
      const search = tools.find((t) => t.name === "task_search")!;

      const results = [makeTask()];
      mockQueryRaw.mockResolvedValue(results);

      const result = await callExecute(search.execute, { query: "groceries" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(1);
      expect(text.query).toBe("groceries");
      expect(mockQueryRaw).toHaveBeenCalled();
      expect(mockTask.findMany).not.toHaveBeenCalled();
    });

    it("uses full-text search with status filter", async () => {
      const tools = createTaskTools(userId);
      const search = tools.find((t) => t.name === "task_search")!;

      mockQueryRaw.mockResolvedValue([]);

      await callExecute(search.execute, { query: "test", status: "pending" });

      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it("uses Prisma ORM when no query is provided", async () => {
      const tools = createTaskTools(userId);
      const search = tools.find((t) => t.name === "task_search")!;

      const tasks = [makeTask()];
      mockTask.findMany.mockResolvedValue(tasks);

      const result = await callExecute(search.execute, { status: "pending" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.count).toBe(1);
      expect(text.query).toBeNull();
      expect(mockTask.findMany).toHaveBeenCalled();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("uses Prisma ORM with multiple filters", async () => {
      const tools = createTaskTools(userId);
      const search = tools.find((t) => t.name === "task_search")!;

      mockTask.findMany.mockResolvedValue([]);

      await callExecute(search.execute, {
        status: "completed",
        priority: "high",
        tag: "urgent",
        dueBefore: "2025-12-31",
      });

      expect(mockTask.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId,
          status: "completed",
          priority: "high",
          tags: { has: "urgent" },
          dueDate: { not: null, lt: expect.any(Date) },
        }),
        orderBy: expect.any(Array),
        take: 100,
      });
    });

    it("ignores empty query string", async () => {
      const tools = createTaskTools(userId);
      const search = tools.find((t) => t.name === "task_search")!;

      mockTask.findMany.mockResolvedValue([]);

      await callExecute(search.execute, { query: "   " });

      expect(mockTask.findMany).toHaveBeenCalled();
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });
  });

  describe("task_delete", () => {
    it("deletes a task", async () => {
      const tools = createTaskTools(userId);
      const del = tools.find((t) => t.name === "task_delete")!;

      const task = makeTask();
      mockTask.findFirst.mockResolvedValue(task);
      mockTask.delete.mockResolvedValue({});

      const result = await callExecute(del.execute, { taskId: "task-1" });
      const text = JSON.parse((result.content[0] as { text: string }).text);

      expect(text.deleted).toBe(true);
      expect(text.id).toBe("task-1");
      expect(text.title).toBe("Buy groceries");
    });

    it("throws when task not found", async () => {
      const tools = createTaskTools(userId);
      const del = tools.find((t) => t.name === "task_delete")!;

      mockTask.findFirst.mockResolvedValue(null);

      await expect(callExecute(del.execute, { taskId: "nonexistent" })).rejects.toThrow(
        "Task nonexistent not found",
      );
    });
  });
});
