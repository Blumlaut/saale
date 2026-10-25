import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAppSettings, mockPushConfigured, mockSendPush, mockAddInbox } = vi.hoisted(() => ({
  mockAppSettings: { findUnique: vi.fn() },
  mockPushConfigured: vi.fn(),
  mockSendPush: vi.fn(),
  mockAddInbox: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { appSettings: mockAppSettings } }));
vi.mock("@/lib/push/config", () => ({ isPushConfigured: mockPushConfigured }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: mockSendPush }));
vi.mock("@/lib/notifications/inbox", () => ({ addInboxNotification: mockAddInbox }));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { isNotificationWanted, notifyUser } from "@/lib/notifications/notify";

const NOTIFICATION = {
  userId: "user-1",
  category: "chatDone" as const,
  title: "Finished responding",
  body: "Weekly planning",
  url: "/dashboard/chat/chat-1",
  tag: "chat-chat-1",
};

describe("notifyUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPushConfigured.mockReturnValue(true);
    mockAppSettings.findUnique.mockResolvedValue({ pushNotifications: null });
    mockSendPush.mockResolvedValue({ sent: 1, pruned: 0, failed: 0 });
    mockAddInbox.mockResolvedValue({ id: "notification-1" });
  });

  it("pushes when the user wants the category", async () => {
    await notifyUser(NOTIFICATION);

    expect(mockSendPush).toHaveBeenCalledWith("user-1", {
      title: "Finished responding",
      body: "Weekly planning",
      url: "/dashboard/chat/chat-1",
      tag: "chat-chat-1",
    });
    // Chat turns show in the conversation itself, so no bell entry.
    expect(mockAddInbox).not.toHaveBeenCalled();
  });

  it("sends nothing when the category is switched off", async () => {
    mockAppSettings.findUnique.mockResolvedValue({ pushNotifications: { chatDone: false } });

    await notifyUser(NOTIFICATION);

    expect(mockSendPush).not.toHaveBeenCalled();
    expect(mockAddInbox).not.toHaveBeenCalled();
  });

  it("sends nothing on an instance without VAPID keys", async () => {
    mockPushConfigured.mockReturnValue(false);

    await notifyUser(NOTIFICATION);

    expect(mockAppSettings.findUnique).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("lists a background event in the bell as well as the device", async () => {
    await notifyUser({ ...NOTIFICATION, category: "email", inApp: true });

    expect(mockAddInbox).toHaveBeenCalledWith("user-1", {
      type: "email",
      title: "Finished responding",
      message: "Weekly planning",
      data: { url: "/dashboard/chat/chat-1" },
    });
    expect(mockSendPush).toHaveBeenCalled();
  });

  it("survives a failing channel without throwing", async () => {
    mockAddInbox.mockRejectedValue(new Error("redis down"));

    await expect(notifyUser({ ...NOTIFICATION, inApp: true })).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    // A bell that could not be written must not stop the push.
    expect(mockSendPush).toHaveBeenCalled();
  });

  it("reports whether a category is wanted at all", async () => {
    expect(await isNotificationWanted("user-1", "email")).toBe(true);

    mockAppSettings.findUnique.mockResolvedValue({ pushNotifications: { email: false } });
    expect(await isNotificationWanted("user-1", "email")).toBe(false);

    mockPushConfigured.mockReturnValue(false);
    expect(await isNotificationWanted("user-1", "email")).toBe(false);
  });
});
