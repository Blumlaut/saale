import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetChatDevice = vi.fn();

vi.mock("@/lib/devices/store", () => ({
  getChatDevice: (...args: unknown[]) => mockGetChatDevice(...args),
}));

import { loadDeviceMcpServers } from "@/lib/devices/entries";
import { deviceUrl } from "@/lib/devices/shared";

const USER_ID = "user-1";

describe("the computer a chat may reach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives a chat with no device no computer at all", async () => {
    await expect(loadDeviceMcpServers(USER_ID, null)).resolves.toEqual({
      entries: [],
      policies: {},
      device: null,
    });
    await expect(loadDeviceMcpServers(USER_ID, undefined)).resolves.toEqual({
      entries: [],
      policies: {},
      device: null,
    });
    expect(mockGetChatDevice).not.toHaveBeenCalled();
  });

  it("gives nothing for a device the user does not own", async () => {
    mockGetChatDevice.mockResolvedValue(null);

    await expect(loadDeviceMcpServers(USER_ID, "someone-elses")).resolves.toEqual({
      entries: [],
      policies: {},
      device: null,
    });
    expect(mockGetChatDevice).toHaveBeenCalledWith(USER_ID, "someone-elses");
  });

  it("declares the chat's own computer, with its groups and an ask policy", async () => {
    mockGetChatDevice.mockResolvedValue({
      id: "dev-1",
      name: "Workstation",
      capabilities: ["screen", "mouse"],
    });

    const { entries, policies, device } = await loadDeviceMcpServers(USER_ID, "dev-1");

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.name).toBe("workstation");
    expect(entry.config).toMatchObject({ type: "http", exposure: "direct" });
    expect("url" in entry.config && entry.config.url).toBe(deviceUrl("dev-1"));
    expect(entry.config.description).toContain("screen, mouse");
    expect(policies).toEqual({ workstation: "ask" });
    expect(device).toEqual({ id: "dev-1", name: "workstation" });
  });
});
