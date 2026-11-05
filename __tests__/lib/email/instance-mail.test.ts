/**
 * The instance's own mail relay: what the admin panel reads and saves, and what
 * a send does when there is nothing to send through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockUpsert, mockDeleteMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    instanceMail: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));

import { _resetKey, decrypt } from "@/lib/crypto";
import {
  instanceMailPatchSchema,
  instanceMailStatus,
  saveInstanceMail,
  sendInstanceMail,
} from "@/lib/email/instance-mail";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "saale",
    encryptedPassword: "ciphertext",
    fromAddress: "saale@example.com",
    fromName: "",
    updatedByUserId: "admin-1",
    updatedAt: new Date("2026-11-05T10:00:00Z"),
    ...overrides,
  };
}

/** The row the last save asked Prisma to write. */
function savedRow(): { create: Record<string, unknown>; update: Record<string, unknown> } {
  const call = mockUpsert.mock.calls.at(-1);
  if (!call) throw new Error("instanceMail.upsert was not called");
  return call[0] as { create: Record<string, unknown>; update: Record<string, unknown> };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  _resetKey();
  mockFindUnique.mockReset();
  mockUpsert.mockReset();
  mockDeleteMany.mockReset();
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  _resetKey();
});

describe("instanceMailPatchSchema", () => {
  it("accepts a partial patch", () => {
    expect(instanceMailPatchSchema.parse({ host: "smtp.example.com" })).toEqual({
      host: "smtp.example.com",
    });
  });

  it("refuses a port outside the range and an unknown security mode", () => {
    expect(instanceMailPatchSchema.safeParse({ port: 70_000 }).success).toBe(false);
    expect(instanceMailPatchSchema.safeParse({ security: "plain" }).success).toBe(false);
  });

  it("refuses a sender that is not an address", () => {
    expect(instanceMailPatchSchema.safeParse({ fromAddress: "saale" }).success).toBe(false);
  });

  it("takes null as forgetting the password", () => {
    expect(instanceMailPatchSchema.parse({ password: null }).password).toBeNull();
  });
});

describe("instanceMailStatus", () => {
  it("reports an instance with no relay as unconfigured", async () => {
    mockFindUnique.mockResolvedValue(null);

    const status = await instanceMailStatus();

    expect(status.configured).toBe(false);
    expect(status.host).toBe("");
    expect(status.port).toBe(587);
    expect(status.hasPassword).toBe(false);
  });

  it("reports a stored relay, and whether a password came with it", async () => {
    mockFindUnique.mockResolvedValue(row());

    const status = await instanceMailStatus();

    expect(status.configured).toBe(true);
    expect(status.host).toBe("smtp.example.com");
    expect(status.fromAddress).toBe("saale@example.com");
    expect(status.hasPassword).toBe(true);
    expect(status.updatedByUserId).toBe("admin-1");
  });

  it("is unconfigured while switched off", async () => {
    mockFindUnique.mockResolvedValue(row({ enabled: false }));
    expect((await instanceMailStatus()).configured).toBe(false);
  });

  it("is unconfigured without a sender", async () => {
    mockFindUnique.mockResolvedValue(row({ fromAddress: "" }));
    expect((await instanceMailStatus()).configured).toBe(false);
  });

  it("falls back to STARTTLS for a security mode it does not know", async () => {
    mockFindUnique.mockResolvedValue(row({ security: "ssl" }));
    expect((await instanceMailStatus()).security).toBe("starttls");
  });
});

describe("saveInstanceMail", () => {
  it("stores a typed password encrypted", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({});

    await saveInstanceMail(
      {
        host: "smtp.example.com",
        fromAddress: "saale@example.com",
        password: "hunter2",
      },
      "admin-1",
    );

    const stored = savedRow().create.encryptedPassword as string;
    expect(stored).not.toContain("hunter2");
    expect(decrypt(stored)).toBe("hunter2");
  });

  it("keeps the stored password when the patch does not carry one", async () => {
    mockFindUnique.mockResolvedValue(row());
    mockUpsert.mockResolvedValue({});

    await saveInstanceMail({ port: 465 }, "admin-1");

    expect(savedRow().update.encryptedPassword).toBe("ciphertext");
    expect(savedRow().update.port).toBe(465);
  });

  it("forgets the password when the patch says null", async () => {
    mockFindUnique.mockResolvedValue(row());
    mockUpsert.mockResolvedValue({});

    await saveInstanceMail({ password: null }, "admin-1");

    expect(savedRow().update.encryptedPassword).toBeNull();
  });

  it("refuses to save a sender that is not an address", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(saveInstanceMail({ fromAddress: "saale" }, "admin-1")).rejects.toThrow();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("sendInstanceMail", () => {
  it("reports nothing sent when no relay is configured", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      sendInstanceMail({ to: "ada@example.com", subject: "Hi", text: "Hello" }),
    ).resolves.toEqual({ sent: false, error: "Instance mail is not configured" });
  });

  it("reports nothing sent while switched off", async () => {
    mockFindUnique.mockResolvedValue(row({ enabled: false }));

    const result = await sendInstanceMail({ to: "ada@example.com", subject: "Hi", text: "Hi" });

    expect(result.sent).toBe(false);
  });
});
