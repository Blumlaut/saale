import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/email/smtp", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/imap", () => ({ appendSentCopy: vi.fn() }));

import { sendEmail } from "@/lib/email/smtp";
import { appendSentCopy } from "@/lib/email/imap";
import { sendMailForAccount, type SendMailParams } from "@/lib/email/send-mail";

const DATE = new Date("2026-10-08T12:00:00.000Z");
const RAW = Buffer.from("From: me@example.com\r\nSubject: hi\r\n\r\nbody");

const params: SendMailParams = {
  account: {
    id: "acc-1",
    email: "me@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: false,
  },
  password: "secret",
  to: ["you@example.com"],
  subject: "hi",
  body: "body",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ messageId: "<m-1@example.com>", raw: RAW, date: DATE });
  vi.mocked(appendSentCopy).mockResolvedValue({ folder: "Sent" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendMailForAccount", () => {
  it("files the delivered message in Sent using the account id", async () => {
    const result = await sendMailForAccount(params);

    expect(appendSentCopy).toHaveBeenCalledWith({ accountId: "acc-1", raw: RAW, date: DATE });
    expect(result).toEqual({ messageId: "<m-1@example.com>", sentFolder: "Sent" });
  });

  it("reports the send as it happened when the copy cannot be filed", async () => {
    vi.mocked(appendSentCopy).mockRejectedValue(new Error("No Sent folder found"));

    const result = await sendMailForAccount(params);

    expect(result).toEqual({ messageId: "<m-1@example.com>", sentFolder: null });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to file sent mail in account acc-1:",
      expect.any(Error),
    );
  });

  it("fails the send instead of reporting success when SMTP rejects it", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("550 relay denied"));

    await expect(sendMailForAccount(params)).rejects.toThrow("550 relay denied");
    expect(appendSentCopy).not.toHaveBeenCalled();
  });

  it("passes the caller's message through to SMTP unchanged", async () => {
    await sendMailForAccount({ ...params, cc: ["cc@example.com"], bodyHtml: "<p>body</p>" });

    expect(sendEmail).toHaveBeenCalledWith({
      ...params,
      cc: ["cc@example.com"],
      bodyHtml: "<p>body</p>",
    });
  });
});
