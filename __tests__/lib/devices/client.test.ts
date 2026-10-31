import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMessage = vi.fn();
const mockDevice = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: { findFirst: (...args: unknown[]) => mockMessage(...args) },
    device: { findFirst: (...args: unknown[]) => mockDevice(...args) },
  },
}));

import { resolveChatDeviceId } from "@/lib/devices/client";

const USER_ID = "user-1";
const SESSION_ID = "session-1";

describe("which computer a chat may reach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the newest user message, not the newest one with a computer", async () => {
    mockMessage.mockResolvedValue({ clientDeviceId: null });

    await expect(resolveChatDeviceId(USER_ID, SESSION_ID)).resolves.toBeNull();

    expect(mockMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: SESSION_ID, role: "user", session: { userId: USER_ID } },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(mockDevice).not.toHaveBeenCalled();
  });

  it("answers with the computer that message came from", async () => {
    mockMessage.mockResolvedValue({ clientDeviceId: "dev-1" });
    mockDevice.mockResolvedValue({ id: "dev-1", name: "workstation", capabilities: [] });

    await expect(resolveChatDeviceId(USER_ID, SESSION_ID)).resolves.toBe("dev-1");
  });

  it("forgets a computer that was disconnected since", async () => {
    mockMessage.mockResolvedValue({ clientDeviceId: "dev-1" });
    mockDevice.mockResolvedValue(null);

    await expect(resolveChatDeviceId(USER_ID, SESSION_ID)).resolves.toBeNull();
  });

  it("answers with nothing for a chat that has no messages", async () => {
    mockMessage.mockResolvedValue(null);

    await expect(resolveChatDeviceId(USER_ID, SESSION_ID)).resolves.toBeNull();
  });
});
