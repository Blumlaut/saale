import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail })),
  },
}));

import os from "os";
import fs from "fs/promises";
import path from "path";
import { sendEmail } from "@/lib/email/smtp";

const account = {
  id: "acc-1",
  email: "me@example.com",
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: "<ignored@example.com>" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read one header out of a raw MIME message, unfolded. */
function header(raw: Buffer, name: string): string {
  const lines = raw.toString().split("\r\n");
  const index = lines.findIndex((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (index === -1) throw new Error(`No ${name} header in message`);
  return lines[index]!.slice(name.length + 1).trim();
}

describe("sendEmail", () => {
  it("hands the transporter the same Message-ID and Date as the raw copy", async () => {
    const result = await sendEmail({
      account,
      password: "secret",
      to: ["you@example.com"],
      subject: "hi",
      body: "body",
    });

    const sent = sendMail.mock.calls[0]![0] as { messageId: string; date: Date };

    expect(sent.messageId).toBe(result.messageId);
    expect(header(result.raw, "Message-ID")).toBe(sent.messageId);
    // A Date header only carries seconds, so that is the granularity on which
    // the delivered message and the copy can agree.
    const copiedAt = new Date(header(result.raw, "Date"));
    expect(Math.floor(copiedAt.getTime() / 1000)).toBe(Math.floor(sent.date.getTime() / 1000));
    expect(result.date).toBe(sent.date);
  });

  it("returns the message body as raw MIME source for the Sent copy", async () => {
    const result = await sendEmail({
      account,
      password: "secret",
      to: ["you@example.com"],
      subject: "Quarterly report",
      body: "numbers attached",
    });

    expect(result.raw).toBeInstanceOf(Buffer);
    expect(header(result.raw, "From")).toBe("me@example.com");
    expect(header(result.raw, "To")).toBe("you@example.com");
    expect(header(result.raw, "Subject")).toBe("Quarterly report");
    expect(result.raw.toString()).toContain("numbers attached");
  });

  it("keeps the raw copy identical to the delivered headers for cc and reply-to", async () => {
    const result = await sendEmail({
      account,
      password: "secret",
      to: ["you@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      replyTo: "replies@example.com",
      subject: "hi",
      body: "body",
    });

    expect(header(result.raw, "Cc")).toBe("cc@example.com");
    expect(header(result.raw, "Reply-To")).toBe("replies@example.com");
    // Bcc belongs on the envelope only — it must never reach the archived copy.
    expect(result.raw.toString()).not.toContain("bcc@example.com");
  });

  it("strips header injection attempts from the subject", async () => {
    const result = await sendEmail({
      account,
      password: "secret",
      to: ["you@example.com"],
      subject: "hi\r\nBcc: attacker@example.com",
      body: "body",
    });

    expect(header(result.raw, "Subject")).toBe("hiBcc: attacker@example.com");
    expect(result.raw.toString()).not.toContain("\r\nBcc: attacker@example.com");
  });

  it("refuses to attach a file outside the base directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-attach-"));

    await expect(
      sendEmail({
        account,
        password: "secret",
        to: ["you@example.com"],
        subject: "hi",
        body: "body",
        attachmentPaths: ["../escape.txt"],
        attachmentBaseDir: dir,
      }),
    ).rejects.toThrow('Access denied: path "../escape.txt" escapes workspace');

    expect(sendMail).not.toHaveBeenCalled();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("attaches a workspace file to both the delivery and the raw copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-attach-"));
    await fs.writeFile(path.join(dir, "notes.txt"), "attachment body");

    const result = await sendEmail({
      account,
      password: "secret",
      to: ["you@example.com"],
      subject: "hi",
      body: "body",
      attachmentPaths: ["notes.txt"],
      attachmentBaseDir: dir,
    });

    expect(sendMail.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({ filename: "notes.txt", contentType: "text/plain" }),
    ]);
    expect(header(result.raw, "Content-Type")).toContain("multipart/mixed");
    expect(result.raw.toString()).toContain(Buffer.from("attachment body").toString("base64"));

    await fs.rm(dir, { recursive: true, force: true });
  });
});
