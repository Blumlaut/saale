import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { countRows, searchRows, type SearchSpec } from "@/lib/search/query";

/**
 * The searchable tables: which columns match, how much each is worth, and the
 * tsvector the migration indexes.
 *
 * Weights are relative. A hit in the subject or title is worth three times a hit
 * in a body, so a word in a subject outranks the same word buried in text.
 */

/** Everything a mail search returns. */
export interface MailHit {
  id: string;
  uid: string;
  fromName: string | null;
  fromEmail: string;
  to: string;
  subject: string;
  date: Date;
  bodyPreview: string | null;
  isRead: boolean;
  isStarred: boolean;
  folder: string;
  tags: string[];
  accountId: string;
}

/**
 * Bodies are stored twice: `bodyText` holds the full message and `bodyPreview`
 * the first 500 characters. Search the fuller of the two.
 */
const MAIL_BODY = Prisma.sql`coalesce(m."bodyText", m."bodyPreview")`;

const MAIL_TSVECTOR = Prisma.sql`(
  setweight(to_tsvector('english', coalesce(m.subject, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(m."fromName", '') || ' ' || coalesce(m."fromEmail", '') || ' ' || coalesce(m."bodyText", m."bodyPreview", '')), 'B')
)`;

/** Everything the mail list and the mail tool filter on besides the query. */
export interface MailFilters {
  accountId?: string | undefined;
  folder?: string | undefined;
  /** Folders to leave out, compared case-insensitively (the trash of each account). */
  excludeFolders?: string[] | undefined;
  unread?: boolean | undefined;
  starred?: boolean | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  tag?: string | undefined;
}

function mailWhere(accountIds: string[], filters: MailFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  if (filters.accountId) {
    clauses.push(Prisma.sql`m."accountId" = ${filters.accountId}`);
  } else {
    clauses.push(Prisma.sql`m."accountId" = ANY(${accountIds})`);
  }

  if (filters.folder) clauses.push(Prisma.sql`m.folder = ${filters.folder}`);
  if (filters.excludeFolders && filters.excludeFolders.length > 0) {
    const lowered = filters.excludeFolders.map((folder) => folder.toLowerCase());
    clauses.push(Prisma.sql`lower(m.folder) <> ALL(${lowered}::text[])`);
  }
  if (filters.unread !== undefined) clauses.push(Prisma.sql`m."isRead" = ${!filters.unread}`);
  if (filters.starred !== undefined) clauses.push(Prisma.sql`m."isStarred" = ${filters.starred}`);
  if (filters.since) clauses.push(Prisma.sql`m.date >= ${filters.since}`);
  if (filters.until) clauses.push(Prisma.sql`m.date < ${filters.until}`);
  if (filters.tag) clauses.push(Prisma.sql`${filters.tag} = ANY(m.tags)`);

  return Prisma.join(clauses, " AND ");
}

export function searchMail(
  query: string,
  opts: { accountIds: string[]; filters?: MailFilters; limit: number; offset?: number },
): Promise<Array<MailHit & { score: number }>> {
  const filters = opts.filters ?? {};
  const spec: SearchSpec = {
    from: Prisma.sql`"EmailMessage" m`,
    where: mailWhere(opts.accountIds, filters),
    fields: [
      { expr: Prisma.sql`m.subject`, weight: 3 },
      { expr: Prisma.sql`m."fromName"`, weight: 1.5 },
      { expr: Prisma.sql`m."fromEmail"`, weight: 1.5 },
      { expr: MAIL_BODY, weight: 1 },
    ],
    tsvector: MAIL_TSVECTOR,
    select: Prisma.sql`m.id, m.uid, m."fromName", m."fromEmail", m.to, m.subject, m.date,
      m."bodyPreview", m."isRead", m."isStarred", m.folder, m.tags, m."accountId"`,
    orderBy: Prisma.sql`m.date DESC`,
    limit: opts.limit,
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
  };

  return searchRows<MailHit>(query, spec);
}

/** Mail search for a user, looking their accounts up first. */
export async function searchUserMail(
  userId: string,
  query: string,
  opts: { filters?: MailFilters; limit: number; offset?: number },
): Promise<Array<MailHit & { score: number }>> {
  const accounts = await prisma.emailAccount.findMany({ where: { userId }, select: { id: true } });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) return [];

  return searchMail(query, { ...opts, accountIds });
}

/** A chat message that matched, with the session it belongs to. */
export interface ChatMessageHit {
  id: string;
  sessionId: string;
  sessionTitle: string;
  role: string;
  content: string;
  createdAt: Date;
}

/**
 * Content only: the tsvector of a chat has to fit one table for the expression
 * index, so a session title matches through its own trigram index instead.
 */
const CHAT_MESSAGE_TSVECTOR = Prisma.sql`(
  setweight(to_tsvector('english', coalesce(c.content, '')), 'B')
)`;

export function searchChatMessages(
  userId: string,
  query: string,
  opts: { limit: number } = { limit: 20 },
): Promise<Array<ChatMessageHit & { score: number }>> {
  return searchRows<ChatMessageHit>(query, {
    from: Prisma.sql`"ChatMessage" c JOIN "ChatSession" s ON c."sessionId" = s.id`,
    where: Prisma.sql`s."userId" = ${userId}`,
    fields: [
      { expr: Prisma.sql`s.title`, weight: 3 },
      { expr: Prisma.sql`c.content`, weight: 1 },
    ],
    tsvector: CHAT_MESSAGE_TSVECTOR,
    select: Prisma.sql`c.id, c."sessionId", s.title AS "sessionTitle", c.role,
      left(c.content, 300) AS content, c."createdAt"`,
    orderBy: Prisma.sql`c."createdAt" DESC`,
    limit: opts.limit,
  });
}

/** A chat matched by its title, for the palette. */
export interface ChatSessionHit {
  id: string;
  title: string;
  lastActivityAt: Date;
  messageCount: number;
}

export function searchChatSessions(
  userId: string,
  query: string,
  opts: { limit: number } = { limit: 10 },
): Promise<Array<ChatSessionHit & { score: number }>> {
  return searchRows<ChatSessionHit>(query, {
    from: Prisma.sql`"ChatSession" s`,
    where: Prisma.sql`s."userId" = ${userId}`,
    fields: [{ expr: Prisma.sql`s.title`, weight: 3 }],
    tsvector: Prisma.sql`(setweight(to_tsvector('english', coalesce(s.title, '')), 'A'))`,
    select: Prisma.sql`s.id, s.title, coalesce(s."lastActivityAt", s."updatedAt") AS "lastActivityAt",
      s."messageCount"`,
    orderBy: Prisma.sql`s."lastActivityAt" DESC`,
    limit: opts.limit,
  });
}

export interface ContactHit {
  id: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  lastSentAt: Date | null;
}

export function searchContacts(
  userId: string,
  query: string,
  opts: { limit: number } = { limit: 20 },
): Promise<Array<ContactHit & { score: number }>> {
  return searchRows<ContactHit>(query, {
    from: Prisma.sql`"Contact" c`,
    where: Prisma.sql`c."userId" = ${userId}`,
    fields: [
      { expr: Prisma.sql`c.name`, weight: 3 },
      { expr: Prisma.sql`c.email`, weight: 2 },
      { expr: Prisma.sql`c.company`, weight: 1.5 },
    ],
    tsvector: Prisma.sql`(
      setweight(to_tsvector('english', coalesce(c.name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(c.email, '') || ' ' || coalesce(c.company, '')), 'B')
    )`,
    select: Prisma.sql`c.id, c.name, c.email, c.company, c.notes, c."lastSentAt"`,
    orderBy: Prisma.sql`c.name ASC`,
    limit: opts.limit,
  });
}

export interface MemoryHit {
  id: string;
  userId: string;
  collection: string;
  title: string;
  content: string;
  tags: string[];
  source: string | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function memorySpec(
  userId: string,
  opts: {
    collection?: string | undefined;
    tags?: string[] | undefined;
    limit: number;
    offset?: number;
  },
): SearchSpec {
  const filters: Prisma.Sql[] = [Prisma.sql`m."userId" = ${userId}`];
  if (opts.collection) filters.push(Prisma.sql`m.collection = ${opts.collection}`);
  if (opts.tags && opts.tags.length > 0) filters.push(Prisma.sql`m.tags && ${opts.tags}::text[]`);

  return {
    from: Prisma.sql`"Memory" m`,
    where: Prisma.join(filters, " AND "),
    fields: [
      { expr: Prisma.sql`m.title`, weight: 3 },
      { expr: Prisma.sql`m.content`, weight: 1 },
    ],
    tsvector: Prisma.sql`(
      setweight(to_tsvector('english', coalesce(m.title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(m.content, '')), 'B')
    )`,
    select: Prisma.sql`m.id, m."userId", m.collection, m.title, m.content, m.tags, m.source,
      m."accessCount", m."createdAt", m."updatedAt"`,
    orderBy: Prisma.sql`m."updatedAt" DESC`,
    limit: opts.limit,
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
  };
}

export function searchMemories(
  userId: string,
  query: string,
  opts: {
    collection?: string | undefined;
    tags?: string[] | undefined;
    limit: number;
    offset?: number;
  },
): Promise<Array<MemoryHit & { score: number }>> {
  return searchRows<MemoryHit>(query, memorySpec(userId, opts));
}

export function countMemories(
  userId: string,
  query: string,
  opts: { collection?: string | undefined; tags?: string[] | undefined },
): Promise<number> {
  return countRows(query, memorySpec(userId, { ...opts, limit: 1 }));
}

export interface TaskHit {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
  tags: string[];
  order: number;
  source: string;
  sourceEmailId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function searchTasks(
  userId: string,
  query: string,
  opts: {
    status?: string | undefined;
    priority?: string | undefined;
    tag?: string | undefined;
    dueBefore?: Date | undefined;
    limit: number;
  },
): Promise<Array<TaskHit & { score: number }>> {
  const filters: Prisma.Sql[] = [Prisma.sql`t."userId" = ${userId}`];
  if (opts.status) filters.push(Prisma.sql`t.status = ${opts.status}`);
  if (opts.priority) filters.push(Prisma.sql`t.priority = ${opts.priority}`);
  if (opts.tag) filters.push(Prisma.sql`t.tags && ARRAY[${opts.tag}]::text[]`);
  if (opts.dueBefore) {
    filters.push(Prisma.sql`t."dueDate" IS NOT NULL AND t."dueDate" < ${opts.dueBefore}`);
  }

  return searchRows<TaskHit>(query, {
    from: Prisma.sql`"Task" t`,
    where: Prisma.join(filters, " AND "),
    fields: [
      { expr: Prisma.sql`t.title`, weight: 3 },
      { expr: Prisma.sql`t.description`, weight: 1 },
    ],
    tsvector: Prisma.sql`(
      setweight(to_tsvector('english', coalesce(t.title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(t.description, '')), 'B')
    )`,
    select: Prisma.sql`t.id, t.title, t.description, t.status, t.priority, t."dueDate", t.tags,
      t."order", t.source, t."sourceEmailId", t."completedAt", t."createdAt", t."updatedAt"`,
    orderBy: Prisma.sql`t."dueDate" ASC NULLS LAST, t."createdAt" DESC`,
    limit: opts.limit,
  });
}

export interface CalendarEventHit {
  id: string;
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  dtStart: Date;
  dtEnd: Date | null;
  timeZone: string | null;
  allDay: boolean;
  calendarName: string;
  calendarColor: string | null;
}

export function searchCalendarEvents(
  userId: string,
  query: string,
  opts: { limit: number } = { limit: 20 },
): Promise<Array<CalendarEventHit & { score: number }>> {
  return searchRows<CalendarEventHit>(query, {
    from: Prisma.sql`"CalendarEvent" e
      JOIN "Calendar" cal ON e."calendarId" = cal.id
      JOIN "CalendarAccount" a ON cal."accountId" = a.id`,
    where: Prisma.sql`a."userId" = ${userId} AND cal.enabled = true`,
    fields: [
      { expr: Prisma.sql`e.summary`, weight: 3 },
      { expr: Prisma.sql`e.location`, weight: 2 },
      { expr: Prisma.sql`e.description`, weight: 1 },
    ],
    tsvector: Prisma.sql`(
      setweight(to_tsvector('english', coalesce(e.summary, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(e.location, '') || ' ' || coalesce(e.description, '')), 'B')
    )`,
    select: Prisma.sql`e.id, e.uid, e.summary, e.description, e.location, e."dtStart", e."dtEnd",
      e."timeZone", e."allDay", cal.name AS "calendarName", cal.color AS "calendarColor"`,
    orderBy: Prisma.sql`e."dtStart" ASC`,
    limit: opts.limit,
  });
}
