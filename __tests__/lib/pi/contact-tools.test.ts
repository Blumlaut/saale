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
  },
}));

vi.mock("@/lib/search/sources", () => ({ searchContacts: vi.fn() }));

import * as db from "@/lib/db";
import { searchContacts } from "@/lib/search/sources";
import { createContactTools } from "@/lib/pi/tools/contact-tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockContact = db.prisma.contact as any;
const mockSearchContacts = searchContacts as unknown as ReturnType<typeof vi.fn>;

// Helper to call execute with all required args, returning the structured value
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) => {
  const result = await execute("call-1", params, undefined, undefined, {} as never);
  return result.structuredContent as never;
};

function makeContact(overrides = {}) {
  return {
    id: "contact-1",
    userId: "user-123",
    name: "Jane Doe",
    email: "jane@example.com",
    company: "Acme",
    notes: null,
    lastSentAt: null,
    ...overrides,
  };
}

describe("createContactTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the five contact tools", () => {
    const tools = createContactTools(userId);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "contacts_list",
      "contacts_search",
      "contacts_create",
      "contacts_update",
      "contacts_delete",
    ]);
  });

  describe("contacts_search", () => {
    it("hands the query to the matcher with the user as the owner", async () => {
      const tools = createContactTools(userId);
      const search = tools.find((t) => t.name === "contacts_search")!;
      mockSearchContacts.mockResolvedValue([{ ...makeContact(), score: 3 }]);

      const result = (await callExecute(search.execute, { query: "jane" })) as {
        count: number;
        contacts: Array<{ name: string; email: string }>;
      };

      expect(mockSearchContacts).toHaveBeenCalledWith(userId, "jane", { limit: 20 });
      expect(result.count).toBe(1);
      expect(result.contacts[0]).toMatchObject({ name: "Jane Doe", email: "jane@example.com" });
    });

    it("searches past a misspelling", async () => {
      const tools = createContactTools(userId);
      const search = tools.find((t) => t.name === "contacts_search")!;
      mockSearchContacts.mockResolvedValue([]);

      await callExecute(search.execute, { query: "janne", limit: 5 });

      expect(mockSearchContacts).toHaveBeenCalledWith(userId, "janne", { limit: 5 });
    });
  });

  describe("contacts_create", () => {
    it("creates a new contact", async () => {
      const tools = createContactTools(userId);
      const create = tools.find((t) => t.name === "contacts_create")!;
      mockContact.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
        makeContact(data),
      );

      const result = (await callExecute(create.execute, {
        name: "Jane Doe",
        email: "jane@example.com",
      })) as { created: boolean; contact: { email: string } };

      expect(result.created).toBe(true);
      expect(result.contact.email).toBe("jane@example.com");
    });

    it("updates instead of erroring when the email already exists", async () => {
      const tools = createContactTools(userId);
      const create = tools.find((t) => t.name === "contacts_create")!;
      // createContact catches PrismaClientKnownRequestError P2002 and returns null,
      // after which the tool upserts the existing row.
      mockContact.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "1",
        }),
      );
      mockContact.findUnique.mockResolvedValue(makeContact({ name: "Jane Doe" }));
      mockContact.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
        makeContact({ ...data }),
      );

      const result = (await callExecute(create.execute, {
        name: "Jane Doe",
        email: "jane@example.com",
      })) as { created: boolean };

      expect(result.created).toBe(false);
      expect(mockContact.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("contacts_delete", () => {
    it("deletes a contact scoped to the user", async () => {
      const tools = createContactTools(userId);
      const del = tools.find((t) => t.name === "contacts_delete")!;
      mockContact.deleteMany.mockResolvedValue({ count: 1 });

      const result = (await callExecute(del.execute, { id: "contact-1" })) as {
        deleted: boolean;
      };

      expect(mockContact.deleteMany).toHaveBeenCalledWith({
        where: { id: "contact-1", userId },
      });
      expect(result.deleted).toBe(true);
    });

    it("throws when the contact is not found for this user", async () => {
      const tools = createContactTools(userId);
      const del = tools.find((t) => t.name === "contacts_delete")!;
      mockContact.deleteMany.mockResolvedValue({ count: 0 });

      await expect(callExecute(del.execute, { id: "missing" })).rejects.toThrow(/not found/);
    });
  });

  describe("contacts_update", () => {
    it("rejects a contact owned by another user", async () => {
      const tools = createContactTools(userId);
      const update = tools.find((t) => t.name === "contacts_update")!;
      // findFirst returns null → the lib throws "Contact not found"
      mockContact.findFirst.mockResolvedValue(null);

      await expect(
        callExecute(update.execute, { id: "other-user-contact", name: "Hacked" }),
      ).rejects.toThrow(/not found/);
      expect(mockContact.update).not.toHaveBeenCalled();
    });
  });
});
