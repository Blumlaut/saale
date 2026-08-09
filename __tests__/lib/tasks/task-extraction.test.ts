import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    emailMessage: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock dispatchAiJob
vi.mock("@/lib/queue/job-handler", () => ({
  dispatchAiJob: vi.fn(),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as queue from "@/lib/queue/job-handler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = db.prisma as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDispatchAiJob = queue.dispatchAiJob as any;

// Import after mocks
import { extractTasksFromEmails } from "@/lib/tasks/task-extraction";

describe("extractTasksFromEmails", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero counts when no emails match", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([]);

    const result = await extractTasksFromEmails({ userId });

    expect(result.emailsScanned).toBe(0);
    expect(result.tasksCreated).toBe(0);
    expect(result.tasksSkipped).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("skips emails with no extractable tasks", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Newsletter",
        bodyText: "Just a newsletter",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue("[]");

    const result = await extractTasksFromEmails({ userId });

    expect(result.emailsScanned).toBe(1);
    expect(result.tasksSkipped).toBe(1);
    expect(result.tasksCreated).toBe(0);
  });

  it("creates tasks from extracted AI response", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Meeting notes",
        bodyText: "Please review the budget",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue(
      JSON.stringify([{ title: "Review Q3 budget", priority: "high", dueDate: "2025-07-15" }]),
    );
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.create.mockResolvedValue({
      id: "task-1",
      userId,
      title: "Review Q3 budget",
      status: "pending",
      priority: "high",
      dueDate: new Date("2025-07-15"),
      tags: [],
      source: "email_extraction",
      sourceEmailId: "email-1",
    });

    const result = await extractTasksFromEmails({ userId });

    expect(result.emailsScanned).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(mockPrisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          title: "Review Q3 budget",
          source: "email_extraction",
          sourceEmailId: "email-1",
        }),
      }),
    );
  });

  it("skips duplicate tasks via case-insensitive DB contains check", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Reminder",
        bodyText: "Buy groceries",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue(
      JSON.stringify([{ title: "Buy groceries", priority: "medium" }]),
    );
    // Simulate existing pending task with similar title (case-insensitive match)
    mockPrisma.task.findMany.mockResolvedValue([
      { id: "task-existing", title: "Buy groceries for dinner" },
    ]);

    const result = await extractTasksFromEmails({ userId });

    expect(result.emailsScanned).toBe(1);
    expect(result.tasksSkipped).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
    // Verify the DB-level contains query was used (not loading all tasks)
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
      where: {
        userId,
        status: "pending",
        title: { contains: "Buy groceries", mode: "insensitive" },
      },
      take: 5,
      select: { id: true, title: true },
    });
  });

  it("creates task when no duplicates found", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "New task",
        bodyText: "Something new",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue(
      JSON.stringify([{ title: "Deploy to production", priority: "high" }]),
    );
    // No existing tasks match
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.create.mockResolvedValue({ id: "task-new" });

    const result = await extractTasksFromEmails({ userId });

    expect(result.tasksCreated).toBe(1);
    expect(result.tasksSkipped).toBe(0);
  });

  it("handles markdown code blocks in AI response", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Tasks",
        bodyText: "Do these things",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue('```json\n[{"title": "Follow up with client"}]\n```');
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.create.mockResolvedValue({ id: "task-1" });

    const result = await extractTasksFromEmails({ userId });

    expect(result.tasksCreated).toBe(1);
  });

  it("handles multiple tasks from single email", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Action items",
        bodyText: "Multiple things to do",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue(
      JSON.stringify([{ title: "Task A" }, { title: "Task B" }, { title: "Task C" }]),
    );
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.create.mockResolvedValue({ id: "task-x" });

    const result = await extractTasksFromEmails({ userId });

    expect(result.tasksCreated).toBe(3);
    expect(mockPrisma.task.create).toHaveBeenCalledTimes(3);
  });

  it("filters out tasks without titles", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Tasks",
        bodyText: "Stuff",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockResolvedValue({});
    mockDispatchAiJob.mockResolvedValue(
      JSON.stringify([{ title: "Valid task" }, { description: "No title here" }, { title: "" }]),
    );
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.create.mockResolvedValue({ id: "task-1" });

    const result = await extractTasksFromEmails({ userId });

    expect(result.tasksCreated).toBe(1);
  });

  it("respects accountId filter", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([]);

    await extractTasksFromEmails({ userId, accountId: "acc-specific" });

    expect(mockPrisma.emailMessage.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ accountId: "acc-specific" }),
      orderBy: { date: "desc" },
      take: 20,
      select: expect.any(Object),
    });
  });

  it("caps limit at 100", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([]);

    await extractTasksFromEmails({ userId, limit: 9999 });

    expect(mockPrisma.emailMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it("collects errors without stopping processing", async () => {
    mockPrisma.emailMessage.findMany.mockResolvedValue([
      {
        id: "email-1",
        subject: "Bad email",
        bodyText: "Content",
        bodyPreview: null,
        date: new Date(),
        accountId: "acc-1",
      },
    ]);
    mockPrisma.emailMessage.update.mockRejectedValue(new Error("DB connection lost"));

    const result = await extractTasksFromEmails({ userId });

    expect(result.emailsScanned).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("DB connection lost");
  });
});
