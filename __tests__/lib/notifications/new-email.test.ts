import { describe, expect, it, vi, beforeEach } from "vitest";

const mockNotifyUser = vi.fn();
vi.mock("@/lib/notifications/notify", () => ({
  notifyUser: (...args: unknown[]) => mockNotifyUser(...args),
}));

import { notifyNewMail } from "@/lib/notifications/new-email";

const base = { userId: "user-1", accountId: "account-1", address: "me@example.com" };

function message(fromName: string | null, subject: string) {
  return { fromName, fromEmail: "sender@example.com", subject };
}

describe("new mail notifications", () => {
  beforeEach(() => {
    mockNotifyUser.mockReset();
    mockNotifyUser.mockResolvedValue(undefined);
  });

  it("names the sender and subject for one message", async () => {
    await notifyNewMail({ ...base, messages: [message("Ada", "Lunch?")], total: 1 });

    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        category: "email",
        title: "New mail in me@example.com",
        body: "Ada: Lunch?",
        url: "/dashboard/mail",
        tag: "mail-account-1",
        inApp: true,
      }),
    );
  });

  it("counts a batch and lists the first few senders", async () => {
    await notifyNewMail({
      ...base,
      messages: [
        message("Ada", "Lunch?"),
        message(null, "Invoice"),
        message("Grace", "Deploy"),
        message("Alan", "Review"),
      ],
      total: 6,
    });

    const notification = mockNotifyUser.mock.calls[0]?.[0];
    expect(notification.title).toBe("6 new emails in me@example.com");
    expect(notification.body).toBe(
      "Ada: Lunch?\nsender@example.com: Invoice\nGrace: Deploy\nand 3 more",
    );
  });

  it("does nothing when the sync created no messages", async () => {
    await notifyNewMail({ ...base, messages: [], total: 0 });

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("cuts a long subject short", async () => {
    await notifyNewMail({ ...base, messages: [message("Ada", "x".repeat(200))], total: 1 });

    const body: string = mockNotifyUser.mock.calls[0]?.[0].body;
    expect(body.length).toBeLessThanOrEqual("Ada: ".length + 80);
    expect(body.endsWith("…")).toBe(true);
  });
});
