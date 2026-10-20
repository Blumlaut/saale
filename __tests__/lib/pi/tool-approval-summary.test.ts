import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma  the resolver must look up the user's own records only.
vi.mock("@/lib/db", () => ({
  prisma: {
    calendarEvent: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    chatSession: { findFirst: vi.fn() },
    emailMessage: { findMany: vi.fn() },
    queueTask: { findFirst: vi.fn() },
    agentDefinition: { findFirst: vi.fn() },
    infraMachine: { findFirst: vi.fn() },
  },
}));

import * as db from "@/lib/db";
import { resolveApprovalSummary } from "@/lib/pi/tool-approval-summary";

const prisma = db.prisma as unknown as {
  calendarEvent: { findFirst: ReturnType<typeof vi.fn> };
  task: { findFirst: ReturnType<typeof vi.fn> };
  chatSession: { findFirst: ReturnType<typeof vi.fn> };
  emailMessage: { findMany: ReturnType<typeof vi.fn> };
  queueTask: { findFirst: ReturnType<typeof vi.fn> };
  agentDefinition: { findFirst: ReturnType<typeof vi.fn> };
  infraMachine: { findFirst: ReturnType<typeof vi.fn> };
};

const USER = "user-1";

describe("resolveApprovalSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible "not found" defaults so each test only sets what it asserts.
    prisma.calendarEvent.findFirst.mockResolvedValue(null);
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.chatSession.findFirst.mockResolvedValue(null);
    prisma.emailMessage.findMany.mockResolvedValue([]);
    prisma.queueTask.findFirst.mockResolvedValue(null);
    prisma.agentDefinition.findFirst.mockResolvedValue(null);
    prisma.infraMachine.findFirst.mockResolvedValue(null);
  });

  it("summarizes mail_send from the arguments alone (no DB access)", async () => {
    const summary = await resolveApprovalSummary(USER, "mail_send", {
      to: ["jane@example.com"],
      subject: "Re: Invoice",
    });

    expect(summary).toBe('Send email to jane@example.com. "Re: Invoice"');
    expect(prisma.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });

  it("resolves a calendar_delete to the event's title and start (scoped to the user)", async () => {
    prisma.calendarEvent.findFirst.mockResolvedValue({
      summary: "Team lunch",
      dtStart: new Date("2026-03-05T15:30:00Z"),
    });

    const summary = await resolveApprovalSummary(USER, "calendar_delete", { id: "evt_1" });

    expect(summary).toMatch(/^Delete event "Team lunch". Mar 5, 2026/);
    expect(prisma.calendarEvent.findFirst).toHaveBeenCalledWith({
      where: { id: "evt_1", calendar: { account: { userId: USER } } },
      select: { summary: true, dtStart: true },
    });
  });

  it("returns null for a calendar_delete when the event is not the user's", async () => {
    // findFirst with the userId scope returns null → another user's record
    const summary = await resolveApprovalSummary(USER, "calendar_delete", { id: "evt_other" });
    expect(summary).toBeNull();
  });

  it("skips the DB for calendar_update when the new title is in the args", async () => {
    const summary = await resolveApprovalSummary(USER, "calendar_update", {
      id: "evt_1",
      summary: "New title",
    });

    expect(summary).toBe('Update event "New title"');
    expect(prisma.calendarEvent.findFirst).not.toHaveBeenCalled();
  });

  it("resolves a calendar_update without a title to the existing event", async () => {
    prisma.calendarEvent.findFirst.mockResolvedValue({ summary: "Team lunch" });
    const summary = await resolveApprovalSummary(USER, "calendar_update", { id: "evt_1" });
    expect(summary).toBe('Update event "Team lunch"');
  });

  it("resolves task_delete to the task title (scoped to the user)", async () => {
    prisma.task.findFirst.mockResolvedValue({ title: "Pay invoice #42" });

    const summary = await resolveApprovalSummary(USER, "task_delete", { taskId: "tsk_1" });

    expect(summary).toBe('Delete task "Pay invoice #42"');
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: "tsk_1", userId: USER },
      select: { title: true },
    });
  });

  it("resolves mail_delete to the first subject and sender, with a count suffix", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { subject: "Re: Invoice #42", fromEmail: "jane@example.com" },
      { subject: "Other", fromEmail: "bob@example.com" },
    ]);

    const summary = await resolveApprovalSummary(USER, "mail_delete", {
      ids: ["m1", "m2"],
    });

    expect(summary).toBe('Delete 2 emails. "Re: Invoice #42" from jane@example.com (and 1 more)');
    expect(prisma.emailMessage.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] }, account: { userId: USER } },
      select: { subject: true, fromEmail: true },
    });
  });

  it("summarizes mail_move with the target folder", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([{ subject: "News", fromEmail: "n@x.com" }]);

    const summary = await resolveApprovalSummary(USER, "mail_move", {
      ids: ["m1"],
      folder: "Archive",
    });

    expect(summary).toBe('Move 1 email to "Archive". "News" from n@x.com');
  });

  it("resolves chat_respond to the chat title", async () => {
    prisma.chatSession.findFirst.mockResolvedValue({ title: "Weekly sync" });

    const summary = await resolveApprovalSummary(USER, "chat_respond", {
      sessionId: "cs_1",
      message: "hello",
    });

    expect(summary).toBe('Send a message in chat "Weekly sync"');
  });

  it("resolves job_run to the job name, falling back to the type", async () => {
    prisma.queueTask.findFirst.mockResolvedValue({ name: null, type: "email_sync" });

    const summary = await resolveApprovalSummary(USER, "job_run", { id: "qt_1" });

    expect(summary).toBe('Run job "email_sync" now');
  });

  it("resolves job_delete to the user-defined job name", async () => {
    prisma.queueTask.findFirst.mockResolvedValue({ name: "Nightly digest", type: "summarization" });

    const summary = await resolveApprovalSummary(USER, "job_delete", { id: "qt_1" });

    expect(summary).toBe('Delete job "Nightly digest"');
  });

  it("resolves agent_job_run to the definition name", async () => {
    prisma.agentDefinition.findFirst.mockResolvedValue({ name: "Summarize inbox" });

    const summary = await resolveApprovalSummary(USER, "agent_job_run", { id: "ad_1" });

    expect(summary).toBe('Run agent job "Summarize inbox" now');
  });

  it("resolves infra_exec through the machine name template", async () => {
    prisma.infraMachine.findFirst.mockResolvedValue({ name: "prod-web" });

    const summary = await resolveApprovalSummary(USER, "infra_exec", {
      id: "im_1",
      command: "uptime",
    });

    expect(summary).toBe("Running uptime on prod-web");
  });

  it("resolves infra_remove_machine to the machine name without a template placeholder", async () => {
    prisma.infraMachine.findFirst.mockResolvedValue({ name: "prod-web" });

    const summary = await resolveApprovalSummary(USER, "infra_remove_machine", { id: "im_1" });

    expect(summary).toBe('Remove machine "prod-web" and its notes');
    expect(summary).not.toContain("{");
  });

  it("returns null for unknown tools instead of guessing", async () => {
    const summary = await resolveApprovalSummary(USER, "mcp_myserver_fetch", { url: "https://x" });
    expect(summary).toBeNull();
  });

  it("returns null when the referenced record is missing (falls back to fields only)", async () => {
    const summary = await resolveApprovalSummary(USER, "task_delete", { taskId: "missing" });
    expect(summary).toBeNull();
  });

  it("never throws  a DB failure degrades to null", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prisma.task.findFirst.mockRejectedValue(new Error("db down"));

    const summary = await resolveApprovalSummary(USER, "task_delete", { taskId: "tsk_1" });

    expect(summary).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
