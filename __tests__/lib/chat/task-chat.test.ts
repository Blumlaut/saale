import { describe, it, expect } from "vitest";
import { buildTaskChatPrompt } from "@/lib/chat/task-chat";
import type { Task } from "@/types/shared";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_123",
    title: "Ship the release",
    description: null,
    status: "pending",
    priority: "medium",
    dueDate: null,
    tags: [],
    order: 0,
    source: "manual",
    sourceEmailId: null,
    completedAt: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("buildTaskChatPrompt", () => {
  it("includes full task details and user context (happy path)", () => {
    const prompt = buildTaskChatPrompt(
      makeTask({
        description: "Tag v1.0 and update the changelog",
        priority: "high",
        dueDate: "2026-01-15T09:00:00.000Z",
        tags: ["release", "ops"],
      }),
      "Customer is blocked until Friday.",
    );

    expect(prompt).toContain("look into task task_123");
    expect(prompt).toContain("Task: Ship the release");
    expect(prompt).toContain("Description: Tag v1.0 and update the changelog");
    expect(prompt).toContain("Priority: high");
    expect(prompt).toContain("Due date: Thursday, Jan 15 2026");
    expect(prompt).toContain("Tags: release, ops");
    expect(prompt).toContain("Additional user context:");
    expect(prompt).toContain("Customer is blocked until Friday.");

    // Context must come after the task details, before the closing instruction.
    const detailsIdx = prompt.indexOf("Tags: release, ops");
    const contextIdx = prompt.indexOf("Customer is blocked until Friday.");
    const closeIdx = prompt.indexOf("Look into the task");
    expect(detailsIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(closeIdx);
  });

  it("omits missing fields and the context section for a minimal task", () => {
    const prompt = buildTaskChatPrompt(makeTask());

    expect(prompt).toContain("look into task task_123");
    expect(prompt).toContain("Task: Ship the release");
    expect(prompt).toContain("Priority: medium");
    expect(prompt).not.toContain("Description:");
    expect(prompt).not.toContain("Due date:");
    expect(prompt).not.toContain("Tags:");
    expect(prompt).not.toContain("Additional user context");
  });

  it("treats whitespace-only context as no context", () => {
    const prompt = buildTaskChatPrompt(makeTask(), "   \n\t ");

    expect(prompt).not.toContain("Additional user context");
  });

  it("trims surrounding whitespace from the user context", () => {
    const prompt = buildTaskChatPrompt(makeTask(), "\n  please hurry\n");

    expect(prompt).toContain("Additional user context:\nplease hurry");
  });
});
