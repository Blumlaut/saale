import { describe, it, expect } from "vitest";
import { taskToResponse, buildTaskUpdateData } from "@/lib/tasks/task-api-helpers";

// Factory to create a Prisma-style Task record (with Date fields)
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
    source: "manual",
    sourceEmailId: null,
    completedAt: null,
    notifiedAt: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("taskToResponse", () => {
  it("serializes a task with all fields", () => {
    const task = makeTask({
      dueDate: new Date("2025-07-15T00:00:00.000Z"),
      sourceEmailId: "email-abc",
    });
    const result = taskToResponse(task);

    expect(result.id).toBe("task-1");
    expect(result.title).toBe("Buy groceries");
    expect(result.description).toBe("Milk, eggs, bread");
    expect(result.status).toBe("pending");
    expect(result.priority).toBe("medium");
    expect(result.dueDate).toBe("2025-07-15T00:00:00.000Z");
    expect(result.tags).toEqual(["shopping"]);
    expect(result.order).toBe(0);
    expect(result.source).toBe("manual");
    expect(result.sourceEmailId).toBe("email-abc");
    expect(result.completedAt).toBeNull();
    expect(result.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.updatedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("converts null dueDate to null string", () => {
    const task = makeTask();
    const result = taskToResponse(task);
    expect(result.dueDate).toBeNull();
  });

  it("converts completedAt to ISO string when present", () => {
    const task = makeTask({
      status: "completed",
      completedAt: new Date("2025-06-01T12:00:00.000Z"),
    });
    const result = taskToResponse(task);
    expect(result.completedAt).toBe("2025-06-01T12:00:00.000Z");
  });

  it("handles empty tags array", () => {
    const task = makeTask({ tags: [] });
    const result = taskToResponse(task);
    expect(result.tags).toEqual([]);
  });

  it("handles null description", () => {
    const task = makeTask({ description: null });
    const result = taskToResponse(task);
    expect(result.description).toBeNull();
  });
});

describe("buildTaskUpdateData", () => {
  it("returns empty object when no updates provided", () => {
    const result = buildTaskUpdateData({});
    expect(result).toEqual({});
  });

  it("includes provided fields", () => {
    const result = buildTaskUpdateData({
      title: "New title",
      priority: "high",
      tags: ["urgent"],
    });

    expect(result.title).toBe("New title");
    expect(result.priority).toBe("high");
    expect(result.tags).toEqual(["urgent"]);
    expect(result.description).toBeUndefined();
    expect(result.dueDate).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it("converts dueDate string to Date", () => {
    const result = buildTaskUpdateData({ dueDate: "2025-07-15" });
    expect(result.dueDate).toBeInstanceOf(Date);
    expect((result.dueDate as Date).toISOString().startsWith("2025-07-15")).toBe(true);
  });

  it("converts null dueDate to null", () => {
    const result = buildTaskUpdateData({ dueDate: null });
    expect(result.dueDate).toBeNull();
  });

  it("includes order when provided", () => {
    const result = buildTaskUpdateData({ order: 5 });
    expect(result.order).toBe(5);
  });

  it("sets completedAt when status is completed", () => {
    const result = buildTaskUpdateData({ status: "completed" });
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("clears completedAt when status is pending", () => {
    const result = buildTaskUpdateData({ status: "pending" });
    expect(result.status).toBe("pending");
    expect(result.completedAt).toBeNull();
  });

  it("does not set completedAt for other status values", () => {
    const result = buildTaskUpdateData({ status: "archived" });
    expect(result.status).toBe("archived");
    expect(result.completedAt).toBeUndefined();
  });

  it("combines field updates with status transition", () => {
    const result = buildTaskUpdateData({
      title: "Updated",
      priority: "high",
      status: "completed",
    });

    expect(result.title).toBe("Updated");
    expect(result.priority).toBe("high");
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("handles description as null", () => {
    const result = buildTaskUpdateData({ description: null });
    expect(result.description).toBeNull();
  });

  it("handles description as string", () => {
    const result = buildTaskUpdateData({ description: "New description" });
    expect(result.description).toBe("New description");
  });
});
