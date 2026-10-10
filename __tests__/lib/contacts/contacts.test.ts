import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: {
    contact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    emailAccount: { findMany: vi.fn() },
    emailMessage: { findMany: vi.fn() },
  },
}));

import * as db from "@/lib/db";
import {
  parseRecipient,
  extractEmails,
  createContact,
  upsertContact,
  learnContactsFromSend,
  listContacts,
  getRecentRecipients,
} from "@/lib/contacts/contacts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockContact = db.prisma.contact as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAccount = db.prisma.emailAccount as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMessage = db.prisma.emailMessage as any;

function makeContact(overrides = {}) {
  return {
    id: "contact-1",
    userId: "user-1",
    name: "Jane Doe",
    email: "jane@example.com",
    company: null,
    notes: null,
    lastSentAt: null,
    ...overrides,
  };
}

describe("parseRecipient", () => {
  it("parses a named address", () => {
    expect(parseRecipient("Jane Doe <jane@example.com>")).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
    });
  });

  it("parses a quoted name containing angle-bracket-safe characters", () => {
    expect(parseRecipient('"Doe, Jane" <jane@x.co>')).toEqual({
      name: "Doe, Jane",
      email: "jane@x.co",
    });
  });

  it("parses a bare angle-bracketed address with no name", () => {
    expect(parseRecipient("<jane@x.co>")).toEqual({ name: null, email: "jane@x.co" });
  });

  it("parses a bare email", () => {
    expect(parseRecipient("jane@x.co")).toEqual({ name: null, email: "jane@x.co" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRecipient("  jane@x.co  ")).toEqual({ name: null, email: "jane@x.co" });
  });

  it("throws on a value without a valid email", () => {
    expect(() => parseRecipient("not an email")).toThrow(/Invalid email/);
    expect(() => parseRecipient("Jane <not-an-email>")).toThrow(/Invalid email/);
  });
});

describe("extractEmails", () => {
  it("handles a JSON string array with named entries", () => {
    expect(extractEmails('["a@x.co", "Bob <b@x.co>"]')).toEqual(["a@x.co", "b@x.co"]);
  });

  it("handles a plain array", () => {
    expect(extractEmails(["a@x.co", "Bob <b@x.co>"])).toEqual(["a@x.co", "b@x.co"]);
  });

  it("handles a comma-separated string", () => {
    expect(extractEmails("a@x.co, b@x.co")).toEqual(["a@x.co", "b@x.co"]);
  });

  it("filters out invalid entries instead of throwing", () => {
    expect(extractEmails("a@x.co, garbage")).toEqual(["a@x.co"]);
  });

  it("returns [] for non-address input", () => {
    expect(extractEmails(null)).toEqual([]);
    expect(extractEmails(42)).toEqual([]);
  });
});

describe("createContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalises the email to lowercase", async () => {
    mockContact.create.mockImplementation(async ({ data }: { data: { email: string } }) =>
      makeContact({ email: data.email }),
    );

    const contact = await createContact("user-1", { name: "Jane", email: "JANE@Example.COM" });

    expect(mockContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "jane@example.com", userId: "user-1" }),
      }),
    );
    expect(contact?.email).toBe("jane@example.com");
  });

  it("returns null on a duplicate email (P2002)", async () => {
    mockContact.create.mockRejectedValue(
      Object.assign(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "1" }),
        {
          code: "P2002",
        },
      ),
    );

    await expect(
      createContact("user-1", { name: "Jane", email: "jane@example.com" }),
    ).resolves.toBeNull();
  });

  it("rethrows non-duplicate errors", async () => {
    mockContact.create.mockRejectedValue(new Error("db down"));
    await expect(
      createContact("user-1", { name: "Jane", email: "jane@example.com" }),
    ).rejects.toThrow("db down");
  });
});

describe("upsertContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new row when the email is unknown", async () => {
    mockContact.findUnique.mockResolvedValue(null);
    mockContact.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact(data),
    );

    const contact = await upsertContact("user-1", { name: "Jane", email: "jane@example.com" });
    expect(mockContact.create).toHaveBeenCalledTimes(1);
    expect(contact.name).toBe("Jane");
  });

  it("keeps a user-typed name over a local-part fallback", async () => {
    mockContact.findUnique.mockResolvedValue(makeContact({ name: "Jane" }));
    mockContact.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact({ ...data }),
    );

    // "jane" is the local part of jane@example.com — a fallback.
    await upsertContact("user-1", { name: "jane", email: "jane@example.com" });

    expect(mockContact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ name: "jane" }) }),
    );
  });

  it("upgrades a fallback name to a real one", async () => {
    mockContact.findUnique.mockResolvedValue(makeContact({ name: "jane" }));
    mockContact.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact({ ...data }),
    );

    await upsertContact("user-1", { name: "Jane Doe", email: "jane@example.com" });

    expect(mockContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Jane Doe" }),
      }),
    );
  });

  it("sets lastSentAt when touchSent is true", async () => {
    mockContact.findUnique.mockResolvedValue(null);
    mockContact.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact(data),
    );

    await upsertContact("user-1", { name: "Jane", email: "jane@example.com", touchSent: true });

    expect(mockContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSentAt: expect.any(Date) }),
      }),
    );
  });

  it("never overwrites existing company or notes", async () => {
    mockContact.findUnique.mockResolvedValue(
      makeContact({ company: "Acme", notes: "met at conf" }),
    );
    mockContact.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact({ ...data }),
    );

    await upsertContact("user-1", {
      name: "Jane",
      email: "jane@example.com",
      company: "Other",
      notes: "new note",
    });

    expect(mockContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ company: "Other", notes: "new note" }),
      }),
    );
  });
});

describe("learnContactsFromSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("learns recipients from to and cc, deduplicated", async () => {
    mockContact.findUnique.mockResolvedValue(null);
    mockContact.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact(data),
    );

    await learnContactsFromSend(
      "user-1",
      ["Jane Doe <jane@example.com>"],
      ["jane@example.com", "bob@example.com"],
    );

    const emails = mockContact.create.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { email: string } }).data.email,
    );
    expect(emails).toEqual(["jane@example.com", "bob@example.com"]);
  });

  it("uses the local part as a name fallback", async () => {
    mockContact.findUnique.mockResolvedValue(null);
    mockContact.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeContact(data),
    );

    await learnContactsFromSend("user-1", ["doe@example.com"]);

    expect(mockContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "doe" }),
      }),
    );
  });

  it("never throws when the book write fails — the send must go through", async () => {
    mockContact.findUnique.mockRejectedValue(new Error("db down"));
    await expect(learnContactsFromSend("user-1", ["jane@example.com"])).resolves.toBeUndefined();
  });
});

describe("listContacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always scopes the query to the user", async () => {
    mockContact.findMany.mockResolvedValue([]);
    await listContacts("user-1", { search: "jane" });
    expect(mockContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("searches name, email, and company", async () => {
    mockContact.findMany.mockResolvedValue([]);
    await listContacts("user-1", { search: "acme" });
    const where = mockContact.findMany.mock.calls[0][0].where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toHaveLength(3);
    expect(where.OR.map((clause) => Object.keys(clause)[0])).toEqual(["name", "email", "company"]);
  });

  it("caps the limit at 500", async () => {
    mockContact.findMany.mockResolvedValue([]);
    await listContacts("user-1", { limit: 10_000 });
    expect(mockContact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });
});

describe("getRecentRecipients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when the user has no email accounts", async () => {
    mockAccount.findMany.mockResolvedValue([]);
    await expect(getRecentRecipients("user-1")).resolves.toEqual([]);
    expect(mockMessage.findMany).not.toHaveBeenCalled();
  });

  it("deduplicates emails in send order and honours the limit", async () => {
    mockAccount.findMany.mockResolvedValue([{ id: "acct-1" }]);
    mockMessage.findMany.mockResolvedValue([
      { to: '["a@x.co", "b@x.co"]' },
      { to: '["a@x.co", "c@x.co"]' },
    ]);

    const recent = await getRecentRecipients("user-1", 2);
    expect(recent).toEqual([
      { name: null, email: "a@x.co" },
      { name: null, email: "b@x.co" },
    ]);
  });
});
