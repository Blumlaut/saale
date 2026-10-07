import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
  requireAccountOwner: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted-password"),
}));

vi.mock("@/lib/email/sync", () => ({
  syncEmailAccount: vi.fn().mockResolvedValue({ newMessages: 1, updatedMessages: 0, errors: [] }),
}));

vi.mock("@/lib/email/auto-sync", () => ({
  createMailboxRefreshJob: vi.fn().mockResolvedValue(undefined),
  setMailboxRefreshJobEnabled: vi.fn().mockResolvedValue(undefined),
  deleteMailboxRefreshJob: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma } from "@prisma/client";
import * as auth from "@/lib/auth";
import { prisma } from "@/lib/db";
import * as autoSync from "@/lib/email/auto-sync";
import * as emailSync from "@/lib/email/sync";
import { POST } from "@/app/api/email/accounts/route";
import { PATCH, DELETE } from "@/app/api/email/accounts/[accountId]/route";

const createdAccount = {
  id: "acc-1",
  userId: "user-1",
  email: "test@example.com",
  enabled: true,
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

const updatedAccount = {
  ...createdAccount,
  email: "new@example.com",
  imapHost: "imap.newhost.com",
  updatedAt: new Date("2025-02-01T00:00:00Z"),
};

function mockAuthOk() {
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: "user-1", email: "owner@example.com" },
  } as never);
}

describe("POST /api/email/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("creates the account and the recurring mailbox refresh job", async () => {
    mockAuthOk();
    vi.mocked(prisma.emailAccount.create).mockResolvedValue(createdAccount as never);
    const request = new Request("http://localhost/api/email/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        password: "secret",
      }),
    }) as never as import("next/server").NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(autoSync.createMailboxRefreshJob).toHaveBeenCalledWith("user-1", "acc-1");
    expect(emailSync.syncEmailAccount).toHaveBeenCalledWith("acc-1");
    const body = (await response.json()) as { sync: { newMessages: number } };
    expect(body.sync.newMessages).toBe(1);
  });

  it("still creates the refresh job when the initial sync errors", async () => {
    mockAuthOk();
    vi.mocked(prisma.emailAccount.create).mockResolvedValue(createdAccount as never);
    vi.mocked(emailSync.syncEmailAccount).mockRejectedValueOnce(new Error("IMAP down"));
    const request = new Request("http://localhost/api/email/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        password: "secret",
      }),
    }) as never as import("next/server").NextRequest;

    await expect(POST(request)).rejects.toThrow("IMAP down");
    expect(autoSync.createMailboxRefreshJob).toHaveBeenCalledWith("user-1", "acc-1");
  });
});

function mockOwnerOk() {
  vi.mocked(auth.requireAccountOwner).mockResolvedValue({
    ok: true,
    account: createdAccount,
  } as never);
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/email/accounts/acc-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as never as import("next/server").NextRequest;
}

describe("PATCH /api/email/accounts/:accountId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockOwnerOk();
  });

  it("updates server settings and encrypts a new password", async () => {
    vi.mocked(prisma.emailAccount.update).mockResolvedValue(updatedAccount as never);

    const response = await PATCH(
      patchRequest({
        email: "new@example.com",
        imapHost: "imap.newhost.com",
        imapPort: 143,
        imapSecure: false,
        smtpHost: "smtp.newhost.com",
        smtpPort: 25,
        smtpSecure: false,
        password: "new-secret",
      }),
      { params: Promise.resolve({ accountId: "acc-1" }) },
    );

    expect(response.status).toBe(200);
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: {
        email: "new@example.com",
        imapHost: "imap.newhost.com",
        imapPort: 143,
        imapSecure: false,
        smtpHost: "smtp.newhost.com",
        smtpPort: 25,
        smtpSecure: false,
        encryptedPassword: "encrypted-password",
      },
    });
    expect(autoSync.setMailboxRefreshJobEnabled).not.toHaveBeenCalled();
  });

  it("keeps the stored password when none is supplied", async () => {
    vi.mocked(prisma.emailAccount.update).mockResolvedValue(updatedAccount as never);

    const response = await PATCH(patchRequest({ imapHost: "imap.other.com" }), {
      params: Promise.resolve({ accountId: "acc-1" }),
    });

    expect(response.status).toBe(200);
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { imapHost: "imap.other.com" },
    });
  });

  it("disables the refresh job when the account is disabled", async () => {
    vi.mocked(prisma.emailAccount.update).mockResolvedValue({
      ...updatedAccount,
      enabled: false,
    } as never);

    await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ accountId: "acc-1" }),
    });

    expect(autoSync.setMailboxRefreshJobEnabled).toHaveBeenCalledWith("user-1", "acc-1", false);
  });

  it("rejects invalid input with 400 and does not touch the database", async () => {
    const response = await PATCH(patchRequest({ email: "not-an-email", imapPort: 99999 }), {
      params: Promise.resolve({ accountId: "acc-1" }),
    });

    expect(response.status).toBe(400);
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the email already exists for the user", async () => {
    vi.mocked(prisma.emailAccount.update).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "6.0.0",
      }),
    );

    const response = await PATCH(patchRequest({ email: "other@example.com" }), {
      params: Promise.resolve({ accountId: "acc-1" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });

  it("returns 404 and does not update when the account is not owned", async () => {
    vi.mocked(auth.requireAccountOwner).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });

    const response = await PATCH(patchRequest({ email: "other@example.com" }), {
      params: Promise.resolve({ accountId: "acc-9" }),
    });

    expect(response.status).toBe(404);
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/email/accounts/:accountId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("removes the mailbox refresh job along with the account", async () => {
    vi.mocked(auth.requireAccountOwner).mockResolvedValue({
      ok: true,
      account: createdAccount,
    } as never);
    vi.mocked(prisma.emailAccount.delete).mockResolvedValue(createdAccount as never);

    const response = await DELETE(
      new Request("http://localhost/api/email/accounts/acc-1", {
        method: "DELETE",
      }) as never as import("next/server").NextRequest,
      { params: Promise.resolve({ accountId: "acc-1" }) },
    );

    expect(response.status).toBe(200);
    expect(autoSync.deleteMailboxRefreshJob).toHaveBeenCalledWith("user-1", "acc-1");
    expect(prisma.emailAccount.delete).toHaveBeenCalledWith({ where: { id: "acc-1" } });
  });

  it("returns 404 and does not touch the job when the account is not owned", async () => {
    vi.mocked(auth.requireAccountOwner).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    });

    const response = await DELETE(
      new Request("http://localhost/api/email/accounts/acc-9", {
        method: "DELETE",
      }) as never as import("next/server").NextRequest,
      { params: Promise.resolve({ accountId: "acc-9" }) },
    );

    expect(response.status).toBe(404);
    expect(autoSync.deleteMailboxRefreshJob).not.toHaveBeenCalled();
    expect(prisma.emailAccount.delete).not.toHaveBeenCalled();
  });
});
