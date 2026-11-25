import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { moveMessage } = vi.hoisted(() => ({ moveMessage: vi.fn() }));

vi.mock("@/lib/email/imap", () => ({ moveMessage }));

vi.mock("@/lib/db", () => ({
  prisma: {
    emailMessage: { update: vi.fn(), delete: vi.fn() },
    emailAccount: { update: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { fileMessage } from "@/lib/email/file-message";

const MESSAGE = { id: "msg-1", accountId: "acc-1", folder: "INBOX", uid: "42" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.emailMessage.update).mockResolvedValue({} as never);
  vi.mocked(prisma.emailMessage.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.emailAccount.update).mockResolvedValue({} as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fileMessage", () => {
  it("moves the message and keeps its row on the UID the server reports", async () => {
    moveMessage.mockResolvedValue({ moved: true, uid: "77" });

    const outcome = await fileMessage({ message: MESSAGE, destination: "Archive" });

    expect(moveMessage).toHaveBeenCalledWith("acc-1", "INBOX", "42", "Archive");
    expect(prisma.emailMessage.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { folder: "Archive", uid: "77" },
    });
    expect(outcome).toEqual({ moved: true });
  });

  it("drops the row and re-walks the account when the server reports no UID for the copy", async () => {
    moveMessage.mockResolvedValue({ moved: true, uid: null });

    await fileMessage({ message: MESSAGE, destination: "Archive" });

    expect(prisma.emailMessage.delete).toHaveBeenCalledWith({ where: { id: "msg-1" } });
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      data: { lastSyncedAt: null },
    });
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });

  it("leaves the row alone when the server refused the move", async () => {
    moveMessage.mockResolvedValue({ moved: false });

    const outcome = await fileMessage({ message: MESSAGE, destination: "Archive" });

    expect(outcome).toEqual({ moved: false });
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
    expect(prisma.emailMessage.delete).not.toHaveBeenCalled();
  });

  it("does not touch the server for a message already in the folder", async () => {
    const outcome = await fileMessage({ message: MESSAGE, destination: "INBOX" });

    expect(moveMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({ moved: true });
  });

  it("drops the row when the destination already holds that UID", async () => {
    moveMessage.mockResolvedValue({ moved: true, uid: "77" });
    vi.mocked(prisma.emailMessage.update).mockRejectedValue(new Error("Unique constraint failed"));

    await fileMessage({ message: MESSAGE, destination: "Archive" });

    expect(prisma.emailMessage.delete).toHaveBeenCalledWith({ where: { id: "msg-1" } });
    expect(console.warn).toHaveBeenCalled();
  });
});
