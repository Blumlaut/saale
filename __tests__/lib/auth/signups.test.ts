import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockCount, mockFindUnique } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: (...args: unknown[]) => mockCount(...args) },
    adminSettings: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}));

import {
  ADMIN_CREATE_USER_PATH,
  SIGNUPS_DISABLED_ERROR,
  areSignupsEnabled,
  assertSignupsAllowed,
} from "@/lib/auth/signups";

beforeEach(() => {
  mockCount.mockReset();
  mockCount.mockResolvedValue(2);
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue({ signupsEnabled: true });
});

describe("areSignupsEnabled", () => {
  it("follows the stored setting", async () => {
    expect(await areSignupsEnabled()).toBe(true);

    mockFindUnique.mockResolvedValue({ signupsEnabled: false });
    expect(await areSignupsEnabled()).toBe(false);
  });

  it("treats an unconfigured instance as open", async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await areSignupsEnabled()).toBe(true);
  });
});

describe("assertSignupsAllowed", () => {
  it("lets a sign-up through while sign-ups are on", async () => {
    await expect(assertSignupsAllowed({ path: "/sign-up/email" })).resolves.toBeUndefined();
  });

  it("refuses a sign-up once an admin has turned them off", async () => {
    mockFindUnique.mockResolvedValue({ signupsEnabled: false });

    await expect(assertSignupsAllowed({ path: "/sign-up/email" })).rejects.toMatchObject({
      body: { code: SIGNUPS_DISABLED_ERROR.code },
    });
  });

  it("refuses an admin-created account too — that path is an admin's job, not a sign-up", async () => {
    mockFindUnique.mockResolvedValue({ signupsEnabled: false });

    await expect(assertSignupsAllowed({ path: ADMIN_CREATE_USER_PATH })).resolves.toBeUndefined();
  });

  it("always lets the first account be created, whatever the setting says", async () => {
    mockCount.mockResolvedValue(0);
    mockFindUnique.mockResolvedValue({ signupsEnabled: false });

    await expect(assertSignupsAllowed({ path: "/sign-up/email" })).resolves.toBeUndefined();
    await expect(assertSignupsAllowed(null)).resolves.toBeUndefined();
  });
});
