import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPairDelete = vi.fn();
const mockPairDeleteMany = vi.fn();
const mockPairCreate = vi.fn();
const mockDeviceDeleteMany = vi.fn();
const mockDeviceCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    devicePairCode: {
      delete: (...args: unknown[]) => mockPairDelete(...args),
      deleteMany: (...args: unknown[]) => mockPairDeleteMany(...args),
      create: (...args: unknown[]) => mockPairCreate(...args),
    },
    device: {
      deleteMany: (...args: unknown[]) => mockDeviceDeleteMany(...args),
      create: (...args: unknown[]) => mockDeviceCreate(...args),
    },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({
        devicePairCode: {
          delete: (...args: unknown[]) => mockPairDelete(...args),
        },
        device: {
          deleteMany: (...args: unknown[]) => mockDeviceDeleteMany(...args),
          create: (...args: unknown[]) => mockDeviceCreate(...args),
        },
      }),
  },
}));

import { Prisma } from "@prisma/client";
import { issuePairCode, normalizePairCode, redeemPairCode } from "@/lib/devices/pairing";
import { hashDeviceToken, isDeviceToken } from "@/lib/devices/tokens";

const USER_ID = "user-1";

const INPUT = {
  code: "ABCD-EFGH",
  name: "Workstation",
  platform: "linux",
  session: "wayland",
  capabilities: ["screen", "mouse", "not-a-group"],
  agentVersion: "1.2.3",
};

describe("pairing codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPairDeleteMany.mockResolvedValue({ count: 0 });
    mockPairCreate.mockResolvedValue({ id: "code-1" });
  });

  it("mints a readable code and stores only its hash", async () => {
    const { code } = await issuePairCode(USER_ID);

    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const stored = mockPairCreate.mock.calls[0]![0] as { data: { codeHash: string } };
    expect(stored.data.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.data.codeHash).not.toContain(code);
  });

  it("drops a user's previous code before minting another", async () => {
    await issuePairCode(USER_ID);
    expect(mockPairDeleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it("accepts a code typed with or without the dash", () => {
    expect(normalizePairCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizePairCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(normalizePairCode("abcd_efgh")).toBe("ABCD-EFGH");
  });
});

describe("redeeming a pairing code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceDeleteMany.mockResolvedValue({ count: 0 });
    mockDeviceCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "device-1", name: data.name }),
    );
  });

  it("returns a token whose hash is what the device row stores", async () => {
    mockPairDelete.mockResolvedValue({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await redeemPairCode(INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDeviceToken(result.token)).toBe(true);

    const created = mockDeviceCreate.mock.calls[0]![0] as {
      data: { tokenHash: string; capabilities: string[]; userId: string; name: string };
    };
    expect(created.data.tokenHash).toBe(hashDeviceToken(result.token));
    expect(created.data.userId).toBe(USER_ID);
    expect(created.data.name).toBe("workstation");
    // An unknown group never reaches the row.
    expect(created.data.capabilities).toEqual(["screen", "mouse"]);
  });

  it("rejects a code that is not in the table", async () => {
    mockPairDelete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    await expect(redeemPairCode(INPUT)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(mockDeviceCreate).not.toHaveBeenCalled();
  });

  it("rejects an expired code", async () => {
    mockPairDelete.mockResolvedValue({
      userId: USER_ID,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(redeemPairCode(INPUT)).resolves.toEqual({ ok: false, reason: "expired" });
    expect(mockDeviceCreate).not.toHaveBeenCalled();
  });

  it("replaces the row of a machine that pairs again", async () => {
    mockPairDelete.mockResolvedValue({
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await redeemPairCode(INPUT);

    expect(mockDeviceDeleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, name: "workstation" },
    });
  });
});
