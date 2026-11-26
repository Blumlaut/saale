import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/search/sources", () => ({
  searchChatSessions: vi.fn(),
  searchChatMessages: vi.fn(),
  searchUserMail: vi.fn(),
  searchContacts: vi.fn(),
  searchTasks: vi.fn(),
  searchCalendarEvents: vi.fn(),
  searchMemories: vi.fn(),
  searchAutomations: vi.fn(),
  searchMachines: vi.fn(),
}));

import {
  searchAutomations,
  searchCalendarEvents,
  searchChatMessages,
  searchChatSessions,
  searchContacts,
  searchMachines,
  searchMemories,
  searchTasks,
  searchUserMail,
} from "@/lib/search/sources";
import { searchPalette } from "@/lib/search/palette";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sessions = vi.mocked(searchChatSessions as any);
const messages = vi.mocked(searchChatMessages as any);
const mail = vi.mocked(searchUserMail as any);
const contacts = vi.mocked(searchContacts as any);
const tasks = vi.mocked(searchTasks as any);
const events = vi.mocked(searchCalendarEvents as any);
const memories = vi.mocked(searchMemories as any);
const automations = vi.mocked(searchAutomations as any);
const machines = vi.mocked(searchMachines as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

function nothingFound(): void {
  sessions.mockResolvedValue([]);
  messages.mockResolvedValue([]);
  mail.mockResolvedValue([]);
  contacts.mockResolvedValue([]);
  tasks.mockResolvedValue([]);
  events.mockResolvedValue([]);
  memories.mockResolvedValue([]);
  automations.mockResolvedValue([]);
  machines.mockResolvedValue([]);
}

describe("searchPalette", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nothingFound();
  });

  it("asks nothing for a blank query", async () => {
    expect(await searchPalette("user-1", "   ")).toEqual([]);
    expect(sessions).not.toHaveBeenCalled();
  });

  it("ranks every source together and trims to the limit", async () => {
    sessions.mockResolvedValue([{ id: "s-1", title: "Weekly planning", score: 2 }]);
    tasks.mockResolvedValue([{ id: "t-1", title: "Plan the week", status: "pending", score: 5 }]);

    const results = await searchPalette("user-1", "week", { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "task", id: "t-1", title: "Plan the week" });
  });

  it("asks only the kinds it was given", async () => {
    await searchPalette("user-1", "week", { kinds: ["task"] });

    expect(tasks).toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(mail).not.toHaveBeenCalled();
    expect(memories).not.toHaveBeenCalled();
  });

  it("collapses a chat's title hit and message hit into one row", async () => {
    sessions.mockResolvedValue([
      { id: "s-1", title: "Weekly planning", lastActivityAt: new Date(), score: 2 },
    ]);
    messages.mockResolvedValue([
      {
        id: "m-1",
        sessionId: "s-1",
        sessionTitle: "Weekly planning",
        role: "assistant",
        content: "the week is already planned",
        createdAt: new Date(),
        score: 9,
      },
    ]);

    const results = await searchPalette("user-1", "week");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "chat", id: "s-1", score: 9 });
    expect(results[0]?.snippet).toContain("already planned");
  });

  it("keeps the title hit when it outranks the message", async () => {
    sessions.mockResolvedValue([{ id: "s-1", title: "Weekly planning", score: 9 }]);
    messages.mockResolvedValue([
      {
        id: "m-1",
        sessionId: "s-1",
        sessionTitle: "Weekly planning",
        role: "user",
        content: "plan the week",
        createdAt: new Date(),
        score: 1,
      },
    ]);

    const [result] = await searchPalette("user-1", "week");

    expect(result?.snippet).toBe("Weekly planning");
  });

  it("sends a mail row to the message in its own account", async () => {
    mail.mockResolvedValue([
      {
        id: "mail-1",
        subject: "Week ahead",
        fromName: "Ada",
        fromEmail: "ada@example.com",
        bodyPreview: "the week looks busy",
        date: new Date(),
        accountId: "account-1",
        score: 4,
      },
    ]);

    const [result] = await searchPalette("user-1", "week", { kinds: ["email"] });

    expect(result?.href).toBe("/dashboard/mail?msg=mail-1&accountId=account-1");
    expect(result?.snippet).toContain("Ada");
  });

  it("says what a task's state and a contact's address are", async () => {
    tasks.mockResolvedValue([
      {
        id: "t-1",
        title: "Plan the week",
        description: null,
        status: "pending",
        dueDate: new Date("2026-01-05T00:00:00.000Z"),
        score: 3,
      },
    ]);
    contacts.mockResolvedValue([
      {
        id: "c-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        company: "Analytical",
        notes: null,
        score: 2,
      },
    ]);

    const results = await searchPalette("user-1", "week", { kinds: ["task", "contact"] });

    expect(results[0]?.snippet).toBe("pending · 2026-01-05");
    expect(results[1]).toMatchObject({
      kind: "contact",
      href: "/dashboard/contacts?id=c-1",
      snippet: "Analytical · ada@example.com",
    });
  });

  it("sends every kind to the row it found", async () => {
    tasks.mockResolvedValue([{ id: "t-1", title: "Plan the week", status: "pending", score: 3 }]);
    events.mockResolvedValue([
      {
        id: "e-1",
        summary: "Week kickoff",
        location: null,
        dtStart: new Date("2026-01-05T09:00:00.000Z"),
        score: 3,
      },
    ]);
    memories.mockResolvedValue([
      { id: "m-1", title: "Week rhythm", content: "the week starts on monday", score: 3 },
    ]);

    const results = await searchPalette("user-1", "week", {
      kinds: ["task", "event", "memory"],
    });
    const hrefs = results.map((result) => result.href);

    expect(hrefs).toContain("/dashboard/tasks?id=t-1");
    expect(hrefs).toContain("/dashboard/calendar?date=2026-01-05");
    expect(hrefs).toContain(`/dashboard/settings/memories?q=${encodeURIComponent("week")}`);
  });

  it("says which automation is paused and where a server logs in", async () => {
    automations.mockResolvedValue([
      {
        id: "w-1",
        name: "Nightly box watch",
        description: "reads the box log",
        enabled: false,
        score: 5,
      },
    ]);
    machines.mockResolvedValue([
      { id: "s-1", name: "build box", host: "10.0.0.4", username: "deploy", score: 4 },
    ]);

    const results = await searchPalette("user-1", "box", {
      kinds: ["automation", "server"],
    });

    expect(results[0]).toMatchObject({
      kind: "automation",
      href: "/dashboard/jobs/automations?id=w-1",
      snippet: "paused · reads the box log",
    });
    expect(results[1]).toMatchObject({
      kind: "server",
      title: "build box",
      href: "/dashboard/infra?id=s-1",
      snippet: "deploy@10.0.0.4",
    });
  });
});
