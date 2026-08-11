import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramAccount: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/telegram/chats", () => ({
  getDefaultTelegramChatInfo: vi.fn(),
  listTelegramChats: vi.fn(),
}));

import * as auth from "@/lib/auth";
import { prisma } from "@/lib/db";
import * as chats from "@/lib/telegram/chats";
import { GET } from "@/app/api/integrations/telegram/chats/route";

describe("GET /api/integrations/telegram/chats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(prisma.telegramAccount.findUnique).not.toHaveBeenCalled();
  });

  it("returns empty chats when no Telegram account exists", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      response: null,
    } as never);
    vi.mocked(prisma.telegramAccount.findUnique).mockResolvedValue(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ chats: [], defaultChat: null });
  });

  it("returns the user's chats and resolved default chat", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      response: null,
    } as never);
    vi.mocked(prisma.telegramAccount.findUnique).mockResolvedValue({ id: "acc-1" } as never);
    vi.mocked(chats.listTelegramChats).mockResolvedValue([
      { chatId: "119075844", label: "Jane", chatType: "private" },
    ]);
    vi.mocked(chats.getDefaultTelegramChatInfo).mockResolvedValue({
      chatId: "119075844",
      label: "Jane",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(prisma.telegramAccount.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { id: true },
    });
    expect(chats.listTelegramChats).toHaveBeenCalledWith("acc-1");
    expect(chats.getDefaultTelegramChatInfo).toHaveBeenCalledWith("acc-1");
    expect(body).toEqual({
      chats: [{ chatId: "119075844", label: "Jane", chatType: "private" }],
      defaultChat: { chatId: "119075844", label: "Jane" },
    });
  });
});
