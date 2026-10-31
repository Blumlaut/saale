import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
const mockFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    deviceCall: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

import { recentDeviceCalls, recordDeviceCall } from "@/lib/devices/audit";

const ENTRY = {
  deviceId: "dev-1",
  userId: "user-1",
  sessionId: "session-1",
  tool: "click",
  summary: "Click at 812, 340 on workstation",
  outcome: "ok" as const,
};

describe("the device audit log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: "call-1" });
  });

  it("records the call against the machine and its owner", async () => {
    await recordDeviceCall(ENTRY);

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        deviceId: "dev-1",
        userId: "user-1",
        sessionId: "session-1",
        tool: "click",
        summary: "Click at 812, 340 on workstation",
        outcome: "ok",
      },
    });
  });

  it("keeps a failed write from failing the call it records", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));

    await expect(recordDeviceCall(ENTRY)).resolves.toBeUndefined();
  });

  it("groups the newest calls per device, capped", async () => {
    mockFindMany.mockResolvedValue([
      {
        deviceId: "dev-1",
        tool: "click",
        summary: "one",
        outcome: "ok",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      },
      {
        deviceId: "dev-1",
        tool: "click",
        summary: "two",
        outcome: "blocked",
        createdAt: new Date("2026-01-01T09:00:00Z"),
      },
      {
        deviceId: "dev-1",
        tool: "click",
        summary: "three",
        outcome: "error",
        createdAt: new Date("2026-01-01T08:00:00Z"),
      },
      {
        deviceId: "dev-1",
        tool: "click",
        summary: "four",
        outcome: "ok",
        createdAt: new Date("2026-01-01T07:00:00Z"),
      },
    ]);

    const grouped = await recentDeviceCalls("user-1", ["dev-1"], 3);

    expect(grouped.get("dev-1")?.map((call) => call.summary)).toEqual(["one", "two", "three"]);
    expect(grouped.get("dev-1")?.[1]?.outcome).toBe("blocked");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", deviceId: { in: ["dev-1"] } } }),
    );
  });

  it("reads nothing when there is no device", async () => {
    await expect(recentDeviceCalls("user-1", [])).resolves.toEqual(new Map());
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
