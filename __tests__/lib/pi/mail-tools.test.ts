// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    emailMessage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

// Mock crypto
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((input: string) => `decrypted:${input}`),
}));

// Mock email modules
vi.mock("@/lib/email/send-mail", () => ({
  sendMailForAccount: vi.fn().mockResolvedValue({ messageId: "msg-123", sentFolder: "Sent" }),
}));

vi.mock("@/lib/email/sync", () => ({
  syncEmailAccount: vi.fn().mockResolvedValue({
    newMessages: 0,
    updatedMessages: 0,
    errors: [],
  }),
}));

vi.mock("@/lib/email/imap", () => ({
  fetchMessageBody: vi.fn().mockResolvedValue(null),
  moveMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  syncMessageFlags: vi.fn().mockResolvedValue(undefined),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import { sendMailForAccount } from "@/lib/email/send-mail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEmailAccount = db.prisma.emailAccount as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEmailMessage = db.prisma.emailMessage as any;

// Import after mocks
import { getUserAccountIds, formatFrom, createMailTools } from "@/lib/pi/tools/mail-tools";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

describe("getUserAccountIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when user has no accounts", async () => {
    mockEmailAccount.findMany.mockResolvedValue([]);

    const ids = await getUserAccountIds("user-1");
    expect(ids).toEqual([]);
    expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { id: true },
    });
  });

  it("returns account IDs for a single account", async () => {
    mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);

    const ids = await getUserAccountIds("user-1");
    expect(ids).toEqual(["acc-1"]);
  });

  it("returns account IDs for multiple accounts", async () => {
    mockEmailAccount.findMany.mockResolvedValue([
      { id: "acc-1" },
      { id: "acc-2" },
      { id: "acc-3" },
    ]);

    const ids = await getUserAccountIds("user-1");
    expect(ids).toEqual(["acc-1", "acc-2", "acc-3"]);
  });

  it("scopes query to userId", async () => {
    mockEmailAccount.findMany.mockResolvedValue([]);

    await getUserAccountIds("user-abc");
    expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
      where: { userId: "user-abc" },
      select: { id: true },
    });
  });
});

describe("formatFrom", () => {
  it("formats with name and email", () => {
    expect(formatFrom("Alice", "alice@example.com")).toBe("Alice <alice@example.com>");
  });

  it("returns just email when name is null", () => {
    expect(formatFrom(null, "noreply@example.com")).toBe("noreply@example.com");
  });

  it("returns just email when name is empty string", () => {
    expect(formatFrom("", "test@example.com")).toBe("test@example.com");
  });

  it("handles names with special characters", () => {
    expect(formatFrom("O'Brien, John", "john@example.com")).toBe(
      "O'Brien, John <john@example.com>",
    );
  });
});

describe("createMailTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all expected tool names", () => {
    const tools = createMailTools(userId);
    const names = tools.map((t) => t.name);
    expect(names).toContain("mail_accounts");
    expect(names).toContain("mail_folders");
    expect(names).toContain("mail_sync");
    expect(names).toContain("mail_list");
    expect(names).toContain("mail_read");
    expect(names).toContain("mail_search");
    expect(names).toContain("mail_send");
    expect(names).toContain("mail_tag");
    expect(names).toContain("mail_move");
    expect(names).toContain("mail_delete");
  });

  describe("mail_list", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailAccount.findFirst.mockResolvedValue(null);
      mockEmailAccount.findFirst.mockResolvedValue({ id: "acc-1", userId });
      mockEmailAccount.findFirst.mockResolvedValue(null);
      mockEmailMessage.findMany.mockResolvedValue([]);
      mockEmailMessage.count.mockResolvedValue(0);

      const tools = createMailTools(userId);
      const mailList = tools.find((t) => t.name === "mail_list")!;

      await callExecute(mailList.execute, {});

      // Should have called findMany (getUserAccountIds) and then findMany for messages
      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });

    it("formats from field using formatFrom helper", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([
        {
          id: "msg-1",
          uid: "1",
          fromName: "Alice",
          fromEmail: "alice@example.com",
          to: "me@example.com",
          subject: "Hello",
          date: new Date("2025-01-01"),
          bodyPreview: "Hi there",
          isRead: false,
          isStarred: false,
          folder: "INBOX",
          tags: [],
          accountId: "acc-1",
        },
        {
          id: "msg-2",
          uid: "2",
          fromName: null,
          fromEmail: "noreply@example.com",
          to: "me@example.com",
          subject: "Notification",
          date: new Date("2025-01-02"),
          bodyPreview: "You have a new notification",
          isRead: true,
          isStarred: false,
          folder: "INBOX",
          tags: [],
          accountId: "acc-1",
        },
      ]);
      mockEmailMessage.count.mockResolvedValue(2);

      const tools = createMailTools(userId);
      const mailList = tools.find((t) => t.name === "mail_list")!;

      const result = await callExecute(mailList.execute, {});
      const text = (result.content[0] as { type: string; text: string }).text;

      // First email has name → "Alice <alice@example.com>"
      expect(text).toContain("Alice <alice@example.com>");
      // Second email has no name → just "noreply@example.com"
      expect(text).toContain("noreply@example.com");
    });

    it("throws when accountId belongs to another user", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);

      const tools = createMailTools(userId);
      const mailList = tools.find((t) => t.name === "mail_list")!;

      await expect(callExecute(mailList.execute, { accountId: "other-user-acc" })).rejects.toThrow(
        "Email account other-user-acc not found",
      );
    });
  });

  describe("mail_read", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([]);

      const tools = createMailTools(userId);
      const mailRead = tools.find((t) => t.name === "mail_read")!;

      await callExecute(mailRead.execute, { ids: ["msg-1"] });

      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });

    it("formats from field correctly", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([
        {
          id: "msg-1",
          uid: "1",
          fromName: "Bob",
          fromEmail: "bob@example.com",
          to: "me@example.com",
          subject: "Test",
          date: new Date("2025-01-01"),
          bodyHtml: "<p>Hello</p>",
          bodyText: "Hello",
          bodyPreview: "Hello",
          isRead: false,
          isStarred: false,
          folder: "INBOX",
          tags: [],
          aiSummary: null,
          spamScore: null,
          accountId: "acc-1",
        },
      ]);
      mockEmailMessage.updateMany.mockResolvedValue({ count: 1 });

      const tools = createMailTools(userId);
      const mailRead = tools.find((t) => t.name === "mail_read")!;

      const result = await callExecute(mailRead.execute, { ids: ["msg-1"] });
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain("Bob <bob@example.com>");
    });
  });

  describe("mail_search", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([]);

      const tools = createMailTools(userId);
      const mailSearch = tools.find((t) => t.name === "mail_search")!;

      await callExecute(mailSearch.execute, { query: "invoice" });

      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });

    it("formats from field correctly", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([
        {
          id: "msg-1",
          fromName: null,
          fromEmail: "alerts@service.com",
          subject: "Invoice #123",
          date: new Date("2025-01-01"),
          bodyPreview: "Your invoice is ready",
          isRead: false,
          folder: "INBOX",
          accountId: "acc-1",
        },
      ]);

      const tools = createMailTools(userId);
      const mailSearch = tools.find((t) => t.name === "mail_search")!;

      const result = await callExecute(mailSearch.execute, { query: "invoice" });
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain("alerts@service.com");
    });
  });

  describe("mail_tag", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([]);

      const tools = createMailTools(userId);
      const mailTag = tools.find((t) => t.name === "mail_tag")!;

      await callExecute(mailTag.execute, { ids: ["msg-1"], addTags: ["important"] });

      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });
  });

  describe("mail_move", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([]);
      mockEmailMessage.updateMany.mockResolvedValue({ count: 0 });

      const tools = createMailTools(userId);
      const mailMove = tools.find((t) => t.name === "mail_move")!;

      await callExecute(mailMove.execute, { ids: ["msg-1"], folder: "Archive" });

      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });
  });

  describe("mail_delete", () => {
    it("uses getUserAccountIds for user isolation", async () => {
      mockEmailAccount.findMany.mockResolvedValue([{ id: "acc-1" }]);
      mockEmailMessage.findMany.mockResolvedValue([]);
      mockEmailMessage.deleteMany.mockResolvedValue({ count: 0 });

      const tools = createMailTools(userId);
      const mailDelete = tools.find((t) => t.name === "mail_delete")!;

      await callExecute(mailDelete.execute, { ids: ["msg-1"] });

      expect(mockEmailAccount.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        select: { id: true },
      });
    });
  });

  describe("mail_send", () => {
    const sendParams = {
      accountId: "acc-1",
      to: ["you@example.com"],
      subject: "hi",
      body: "body",
    };

    beforeEach(() => {
      mockEmailAccount.findFirst.mockResolvedValue({
        id: "acc-1",
        userId,
        email: "me@example.com",
        encryptedPassword: "enc",
      });
      vi.mocked(sendMailForAccount).mockResolvedValue({
        messageId: "msg-123",
        sentFolder: "Sent",
      });
    });

    it("scopes the sending account to the caller's user", async () => {
      const tools = createMailTools(userId);
      const mailSend = tools.find((t) => t.name === "mail_send")!;

      await callExecute(mailSend.execute, sendParams);

      expect(mockEmailAccount.findFirst).toHaveBeenCalledWith({
        where: { id: "acc-1", userId: "user-123" },
      });
    });

    it("reports the folder the sent copy was filed in", async () => {
      const tools = createMailTools(userId);
      const mailSend = tools.find((t) => t.name === "mail_send")!;

      const result = await callExecute(mailSend.execute, sendParams);

      expect(result.structuredContent).toEqual({
        sent: true,
        messageId: "msg-123",
        to: ["you@example.com"],
        subject: "hi",
        sentFolder: "Sent",
      });
    });

    it("still reports the send when no copy could be filed in Sent", async () => {
      vi.mocked(sendMailForAccount).mockResolvedValue({
        messageId: "msg-123",
        sentFolder: null,
      });

      const tools = createMailTools(userId);
      const mailSend = tools.find((t) => t.name === "mail_send")!;

      const result = await callExecute(mailSend.execute, sendParams);

      expect(result.structuredContent).toMatchObject({ sent: true, sentFolder: null });
    });

    it("refuses to send from an account the user does not own", async () => {
      mockEmailAccount.findFirst.mockResolvedValue(null);

      const tools = createMailTools(userId);
      const mailSend = tools.find((t) => t.name === "mail_send")!;

      await expect(callExecute(mailSend.execute, sendParams)).rejects.toThrow(
        "Email account acc-1 not found",
      );
      expect(sendMailForAccount).not.toHaveBeenCalled();
    });
  });
});
