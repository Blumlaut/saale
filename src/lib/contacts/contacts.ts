import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { splitEmailAddresses } from "@/lib/email/utils";

// ─── Address parsing ─────────────────────────────────────────────────────────

/**
 * Matches `Name <email>`, `"Name" <email>`, or `<email>`.
 * Groups: 1 = quoted name, 2 = plain name, 3 = email.
 */
const NAMED_ADDRESS = /^(?:"([^"]*)"|([^<]*))?\s*<([^<>]+)>$/;

/**
 * Parse one recipient string into name + email.
 *
 * Accepts `Name <email>`, `"Name" <email>`, and bare `email`. Throws on
 * values with no valid email part. callers pass user-typed or agent-supplied
 * strings, so silent acceptance of garbage is how a bad address reaches SMTP.
 */
export function parseRecipient(raw: string): { name: string | null; email: string } {
  const input = raw.trim();
  const match = input.match(NAMED_ADDRESS);
  const email = (match ? (match[3] ?? "") : input).trim();

  if (!z.email().safeParse(email).success) {
    throw new Error(`Invalid email address: ${raw}`);
  }

  if (!match) return { name: null, email };
  const name = (match[1] ?? match[2] ?? "").trim();
  return { name: name || null, email };
}

/** Extract plain emails from a stored `to` field (JSON array or comma string). */
export function extractEmails(raw: unknown): string[] {
  let entries: string[];
  if (Array.isArray(raw)) {
    entries = raw.map(String);
  } else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      entries = raw.split(",");
    }
  } else {
    return [];
  }
  return entries
    .flatMap((entry) => splitEmailAddresses(entry))
    .map((entry) => {
      try {
        return parseRecipient(entry).email;
      } catch {
        return "";
      }
    })
    .filter((email) => z.email().safeParse(email).success);
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const contactCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("Invalid email").max(320),
  company: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(4000).optional(),
});

export const contactUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    company: z.string().trim().max(200).nullable(),
    notes: z.string().trim().max(4000).nullable(),
  })
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "Nothing to update",
  });

export type ContactDto = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  lastSentAt: string | null;
};

export function toContactDto(contact: {
  id: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  lastSentAt: Date | null;
}): ContactDto {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    company: contact.company,
    notes: contact.notes,
    lastSentAt: contact.lastSentAt ? contact.lastSentAt.toISOString() : null,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function listContacts(
  userId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<ContactDto[]> {
  const where: Prisma.ContactWhereInput = { userId };
  const search = opts.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { company: { contains: search, mode: "insensitive" } },
    ];
  }
  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { name: "asc" },
    take: Math.min(opts.limit ?? 200, 500),
  });
  return contacts.map(toContactDto);
}

export async function getContact(userId: string, id: string) {
  const contact = await prisma.contact.findFirst({ where: { id, userId } });
  return contact ? toContactDto(contact) : null;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

// The unique key is exact-match, but email addresses are case-insensitive in
// practice. normalise at every write boundary so "John@X.com" and
// "john@x.com" cannot become two rows.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether a display name is just the email's local part. i.e. a fallback
 * generated when no real name was known, safe to upgrade later.
 */
function isFallbackName(name: string, email: string): boolean {
  return name === (email.split("@")[0] || email);
}

/**
 * Create a contact. Returns `null` when the email already exists for this
 * user. callers decide between a 409 and an upsert.
 */
export async function createContact(
  userId: string,
  data: z.infer<typeof contactCreateSchema>,
): Promise<ContactDto | null> {
  try {
    const contact = await prisma.contact.create({
      data: {
        userId,
        name: data.name,
        email: normalizeEmail(data.email),
        ...(data.company ? { company: data.company } : {}),
        ...(data.notes ? { notes: data.notes } : {}),
      },
    });
    return toContactDto(contact);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return null;
    }
    throw err;
  }
}

export interface UpsertContactInput extends z.infer<typeof contactCreateSchema> {
  /** Set lastSentAt to now (used by the learner). */
  touchSent?: boolean;
}

/**
 * Create a contact, or refresh the existing row for the same email.
 *
 * Name handling: a real name always overwrites; a local-part fallback fills in
 * only when the stored name is itself a fallback. it never replaces a name
 * the user typed. Company and notes are filled when empty, never overwritten.
 */
export async function upsertContact(userId: string, data: UpsertContactInput): Promise<ContactDto> {
  const email = normalizeEmail(data.email);
  const touch = data.touchSent ? new Date() : null;
  const existing = await prisma.contact.findUnique({
    where: { userId_email: { userId, email } },
  });
  if (existing) {
    const upgradeName =
      !isFallbackName(data.name, email) || isFallbackName(existing.name, existing.email);
    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(upgradeName ? { name: data.name } : {}),
        ...(data.company && !existing.company ? { company: data.company } : {}),
        ...(data.notes && !existing.notes ? { notes: data.notes } : {}),
        ...(touch ? { lastSentAt: touch } : {}),
      },
    });
    return toContactDto(updated);
  }
  const contact = await prisma.contact.create({
    data: {
      userId,
      name: data.name,
      email,
      ...(data.company ? { company: data.company } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(touch ? { lastSentAt: touch } : {}),
    },
  });
  return toContactDto(contact);
}

export async function updateContact(
  userId: string,
  id: string,
  data: z.infer<typeof contactUpdateSchema>,
): Promise<ContactDto> {
  // Scope by userId first. a raw id is attacker-guessable across users.
  const existing = await prisma.contact.findFirst({ where: { id, userId } });
  if (!existing) throw new Error("Contact not found");
  const contact = await prisma.contact.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.email !== undefined ? { email: normalizeEmail(data.email) } : {}),
      ...(data.company !== undefined ? { company: data.company } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });
  return toContactDto(contact);
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
  const result = await prisma.contact.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/**
 * Teach the contact book from a send. Every recipient becomes a contact row:
 * new addresses are created (name falls back to the email's local part),
 * existing ones get their name/lastSentAt refreshed. Never throws. a broken
 * book must not fail the send.
 */
export async function learnContactsFromSend(
  userId: string,
  to: string[],
  cc?: string[],
): Promise<void> {
  try {
    // Deduplicate on the normalised email. `Jane <a@x.co>` in `to` and
    // `a@x.co` in `cc` are the same recipient.
    const seen = new Set<string>();
    const recipients: Array<{ name: string; email: string }> = [];
    for (const raw of [...to, ...(cc ?? [])]) {
      const { name, email } = parseRecipient(raw);
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const localPart = email.split("@")[0] || email;
      recipients.push({ name: name ?? localPart, email });
    }
    await Promise.all(
      recipients.map((r) =>
        upsertContact(userId, { name: r.name, email: r.email, touchSent: true }),
      ),
    );
  } catch (err) {
    console.error(`[contacts] Failed to learn contacts for user ${userId}:`, err);
  }
}

/**
 * Most recent recipients from the user's Sent folders. the "recent"
 * suggestions for the compose picker. Returns bare emails with a name only
 * when the stored address carried one.
 */
export async function getRecentRecipients(
  userId: string,
  limit = 25,
): Promise<Array<{ name: string | null; email: string }>> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { id: true },
  });
  if (accounts.length === 0) return [];

  const messages = await prisma.emailMessage.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, folder: "Sent" },
    orderBy: { date: "desc" },
    take: 300,
    select: { to: true },
  });

  const seen = new Set<string>();
  const recent: Array<{ name: string | null; email: string }> = [];
  for (const message of messages) {
    for (const entry of extractEmails(message.to)) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push({ name: null, email: entry });
      if (recent.length >= limit) return recent;
    }
  }
  return recent;
}
