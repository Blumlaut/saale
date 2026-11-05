/**
 * The two mails Saale writes on its own account: what they say, and that the
 * link a person has to click is in both parts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@/lib/email/instance-mail", () => ({
  sendInstanceMail: (...args: unknown[]) => mockSend(...args),
}));

vi.mock("@/lib/branding/workspace", () => ({
  getWorkspaceName: async () => "Acme Console",
}));

import { sendPasswordResetMail, sendVerificationMail } from "@/lib/email/instance-mail-messages";

const URL = "https://saale.example.com/api/auth/verify-email?token=abc";

interface SentMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** The message the last call asked for. */
function sentMessage(): SentMessage {
  const call = mockSend.mock.calls.at(-1);
  if (!call) throw new Error("sendInstanceMail was not called");
  return call[0] as SentMessage;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ sent: true });
});

describe("sendVerificationMail", () => {
  it("names the instance and carries the link in both parts", async () => {
    await sendVerificationMail("ada@example.com", URL);

    const message = sentMessage();
    expect(message.to).toBe("ada@example.com");
    expect(message.subject).toBe("Confirm your address for Acme Console");
    expect(message.text).toContain(URL);
    expect(message.html).toContain(URL);
  });
});

describe("sendPasswordResetMail", () => {
  it("says who asked and carries the link in both parts", async () => {
    await sendPasswordResetMail("ada@example.com", URL);

    const message = sentMessage();
    expect(message.subject).toBe("Reset your Acme Console password");
    expect(message.text).toMatch(/asked to reset/);
    expect(message.text).toContain(URL);
    expect(message.html).toContain(URL);
  });

  it("passes on what the relay answered", async () => {
    mockSend.mockResolvedValue({ sent: false, error: "connection refused" });

    await expect(sendPasswordResetMail("ada@example.com", URL)).resolves.toEqual({
      sent: false,
      error: "connection refused",
    });
  });
});
