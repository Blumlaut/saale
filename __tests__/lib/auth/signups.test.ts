import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockCount, mockFindUnique, mockSsoRows } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockFindUnique: vi.fn(),
  mockSsoRows: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: (...args: unknown[]) => mockCount(...args) },
    adminSettings: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
    instanceSso: { findMany: (...args: unknown[]) => mockSsoRows(...args) },
  },
}));

import {
  ADMIN_CREATE_USER_PATH,
  SIGNUPS_DISABLED_ERROR,
  areSignupsEnabled,
  assertSignupsAllowed,
} from "@/lib/auth/signups";
import { _resetKey, encrypt } from "@/lib/crypto";
import { invalidateSsoConfig } from "@/lib/auth/sso";
import { SSO_SIGNUP_REFUSED } from "@/lib/auth/sso-login";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  _resetKey();
  invalidateSsoConfig();
  mockCount.mockReset();
  mockCount.mockResolvedValue(2);
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue({ signupsEnabled: true });
  mockSsoRows.mockReset();
  mockSsoRows.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  _resetKey();
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

  it("refuses an admin-created account too  that path is an admin's job, not a sign-up", async () => {
    mockFindUnique.mockResolvedValue({ signupsEnabled: false });

    await expect(assertSignupsAllowed({ path: ADMIN_CREATE_USER_PATH })).resolves.toBeUndefined();
  });

  it("always lets the first account be created, whatever the setting says", async () => {
    mockCount.mockResolvedValue(0);
    mockFindUnique.mockResolvedValue({ signupsEnabled: false });

    await expect(assertSignupsAllowed({ path: "/sign-up/email" })).resolves.toBeUndefined();
    await expect(assertSignupsAllowed(null)).resolves.toBeUndefined();
  });

  describe("a single sign-on login", () => {
    const SSO_CALLBACK = "/callback/sso-abc12345";

    /** One ready provider, allowing a single domain. */
    function storeProvider(allowedDomains: string[] = ["example.com"]) {
      invalidateSsoConfig();
      mockSsoRows.mockResolvedValue([
        {
          id: "sso-1",
          slug: "abc12345",
          enabled: true,
          issuer: "https://login.example.com/tenant",
          clientId: "saale",
          encryptedClientSecret: encrypt("secret"),
          name: "Company SSO",
          scopes: ["openid", "profile", "email"],
          allowedDomains,
          updatedByUserId: "admin-1",
          updatedAt: new Date("2026-11-12T10:00:00Z"),
        },
      ]);
    }

    it("creates an account for an allowed domain even with sign-ups off", async () => {
      storeProvider();
      mockFindUnique.mockResolvedValue({ signupsEnabled: false });

      await expect(
        assertSignupsAllowed({ path: SSO_CALLBACK }, "ada@example.com"),
      ).resolves.toBeUndefined();
    });

    it("reads the domains of the provider that asked", async () => {
      storeProvider([]);

      await expect(
        assertSignupsAllowed({ path: SSO_CALLBACK }, "ada@example.com"),
      ).rejects.toMatchObject({ body: { code: SSO_SIGNUP_REFUSED.code } });
    });

    it("refuses an address outside the domain list", async () => {
      storeProvider();
      await expect(
        assertSignupsAllowed({ path: SSO_CALLBACK }, "ada@elsewhere.test"),
      ).rejects.toMatchObject({ body: { code: SSO_SIGNUP_REFUSED.code } });
    });

    it("refuses an address it cannot read", async () => {
      storeProvider();
      mockFindUnique.mockResolvedValue({ signupsEnabled: false });

      await expect(assertSignupsAllowed({ path: SSO_CALLBACK })).rejects.toMatchObject({
        body: { code: SSO_SIGNUP_REFUSED.code },
      });
    });
  });
});
