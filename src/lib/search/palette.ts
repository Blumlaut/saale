/**
 * The ⌘K palette's search: every source the agent can reach, answered as one
 * ranked list.
 *
 * The sources live in `sources.ts` and each one returns its own hit type, which
 * suits the page that renders one table. A palette shows a single list, where a
 * to-do and an email compete for the same slot, so the mapping from a hit to a
 * row lives here, once, and the route only authenticates and responds.
 */

import { snippetAround } from "./snippet";
import {
  DEFAULT_PALETTE_LIMIT,
  MAX_PALETTE_LIMIT,
  PALETTE_KINDS,
  type PaletteKind,
  type PaletteResult,
} from "./palette-result";
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
  type AutomationHit,
  type CalendarEventHit,
  type ContactHit,
  type MachineHit,
  type TaskHit,
} from "./sources";

/** How much of a matched body a row shows. */
const SNIPPET_LENGTH = 100;

export interface PaletteQuery {
  /** Which sources to ask. Every kind when omitted. */
  kinds?: readonly PaletteKind[];
  limit?: number;
}

/** One row's worth of text, from whatever a source matched. */
function contactSnippet(contact: ContactHit, query: string): string {
  const about = [contact.company, contact.email].filter(Boolean).join(" · ");
  return snippetAround(contact.notes ?? about, query, SNIPPET_LENGTH);
}

function taskSnippet(task: TaskHit, query: string): string {
  const excerpt = snippetAround(task.description ?? "", query, SNIPPET_LENGTH);
  if (excerpt) return excerpt;
  const due = task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null;
  return due ? `${task.status} · ${due}` : task.status;
}

function eventSnippet(event: CalendarEventHit): string {
  const day = event.dtStart.toISOString().slice(0, 10);
  return event.location ? `${day} · ${event.location}` : day;
}

/** Whether it is paused, and whatever the description matched. */
function automationSnippet(automation: AutomationHit, query: string): string {
  const excerpt = snippetAround(automation.description ?? "", query, SNIPPET_LENGTH);
  if (!automation.enabled) return excerpt ? `paused · ${excerpt}` : "paused";
  return excerpt;
}

function machineSnippet(machine: MachineHit): string {
  return `${machine.username}@${machine.host}`;
}

/**
 * Chats, one row each.
 *
 * A chat matches by its title or by anything said in it, and the two collapse
 * into a single row per chat: two rows for one conversation would take the slot
 * another chat needed.
 */
async function chatRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const [sessions, messages] = await Promise.all([
    searchChatSessions(userId, query, { limit }),
    searchChatMessages(userId, query, { limit }),
  ]);

  const bySession = new Map<string, PaletteResult>();
  for (const session of sessions) {
    bySession.set(session.id, {
      kind: "chat",
      id: session.id,
      title: session.title,
      snippet: session.title,
      score: session.score,
      href: `/dashboard/chat/${session.id}`,
    });
  }

  for (const message of messages) {
    const existing = bySession.get(message.sessionId);
    if (existing && existing.score >= message.score) continue;
    bySession.set(message.sessionId, {
      kind: "chat",
      id: message.sessionId,
      title: message.sessionTitle,
      snippet: snippetAround(message.content, query, SNIPPET_LENGTH),
      score: message.score,
      href: `/dashboard/chat/${message.sessionId}`,
    });
  }

  return [...bySession.values()];
}

async function mailRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchUserMail(userId, query, { limit });

  return hits.map((email) => {
    const params = new URLSearchParams({ msg: email.id, accountId: email.accountId });
    return {
      kind: "email",
      id: email.id,
      title: email.subject || "(no subject)",
      snippet: `${email.fromName || email.fromEmail}: ${snippetAround(
        email.bodyPreview ?? "",
        query,
        SNIPPET_LENGTH,
      )}`,
      score: email.score,
      href: `/dashboard/mail?${params.toString()}`,
    };
  });
}

async function contactRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchContacts(userId, query, { limit });

  return hits.map((contact) => ({
    kind: "contact",
    id: contact.id,
    title: contact.name,
    snippet: contactSnippet(contact, query),
    score: contact.score,
    href: `/dashboard/contacts?id=${encodeURIComponent(contact.id)}`,
  }));
}

async function taskRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchTasks(userId, query, { limit });

  return hits.map((task) => ({
    kind: "task",
    id: task.id,
    title: task.title,
    snippet: taskSnippet(task, query),
    score: task.score,
    href: `/dashboard/tasks?id=${encodeURIComponent(task.id)}`,
  }));
}

async function eventRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchCalendarEvents(userId, query, { limit });

  return hits.map((event) => ({
    kind: "event",
    id: event.id,
    title: event.summary || "(no title)",
    snippet: eventSnippet(event),
    score: event.score,
    // The calendar has no per-event page: it opens on the day the event is on.
    href: `/dashboard/calendar?date=${event.dtStart.toISOString().slice(0, 10)}`,
  }));
}

async function memoryRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchMemories(userId, query, { limit });

  return hits.map((memory) => ({
    kind: "memory",
    id: memory.id,
    title: memory.title,
    snippet: snippetAround(memory.content, query, SNIPPET_LENGTH),
    score: memory.score,
    // The list opens with this search already typed, so the row is on screen.
    href: `/dashboard/settings/memories?q=${encodeURIComponent(query)}`,
  }));
}

async function automationRows(
  userId: string,
  query: string,
  limit: number,
): Promise<PaletteResult[]> {
  const hits = await searchAutomations(userId, query, { limit });

  return hits.map((automation) => ({
    kind: "automation",
    id: automation.id,
    title: automation.name,
    snippet: automationSnippet(automation, query),
    score: automation.score,
    // The automations page opens one it is told about, the way a notification does.
    href: `/dashboard/jobs/automations?id=${encodeURIComponent(automation.id)}`,
  }));
}

async function machineRows(userId: string, query: string, limit: number): Promise<PaletteResult[]> {
  const hits = await searchMachines(userId, query, { limit });

  return hits.map((machine) => ({
    kind: "server",
    id: machine.id,
    title: machine.name,
    snippet: machineSnippet(machine),
    score: machine.score,
    href: `/dashboard/infra?id=${encodeURIComponent(machine.id)}`,
  }));
}

/** The one function per kind. A new kind is one entry here and one label. */
const ROW_SEARCHES: Record<
  PaletteKind,
  (userId: string, query: string, limit: number) => Promise<PaletteResult[]>
> = {
  chat: chatRows,
  email: mailRows,
  contact: contactRows,
  task: taskRows,
  event: eventRows,
  memory: memoryRows,
  automation: automationRows,
  server: machineRows,
};

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PALETTE_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_PALETTE_LIMIT));
}

/**
 * Every row matching `query`, best first.
 *
 * Scores come from one ranking expression shared by every source, so they are
 * comparable: a title hit outranks a body hit whichever table it came from.
 */
export async function searchPalette(
  userId: string,
  query: string,
  options: PaletteQuery = {},
): Promise<PaletteResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = boundedLimit(options.limit ?? DEFAULT_PALETTE_LIMIT);
  const kinds = new Set(options.kinds ?? PALETTE_KINDS);

  const groups = await Promise.all(
    PALETTE_KINDS.filter((kind) => kinds.has(kind)).map((kind) =>
      ROW_SEARCHES[kind](userId, trimmed, limit),
    ),
  );

  return groups
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
