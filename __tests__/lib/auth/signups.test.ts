import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { SSO_SIGNUP_REFUSED } from "@/lib/auth/sso-login";

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
    const SSO_CALLBACK = "/callback/sso-oidc";

    beforeEach(() => {
      process.env.SSO_OIDC_ISSUER = "https://login.example.com";
      process.env.SSO_OIDC_CLIENT_ID = "saale";
      process.env.SSO_OIDC_CLIENT_SECRET = "secret";
      process.env.SSO_ALLOWED_DOMAINS = "example.com";
    });

    afterEach(() => {
      delete process.env.SSO_OIDC_ISSUER;
      delete process.env.SSO_OIDC_CLIENT_ID;
      delete process.env.SSO_OIDC_CLIENT_SECRET;
      delete process.env.SSO_ALLOWED_DOMAINS;
    });

    it("creates an account for an allowed domain even with sign-ups off", async () => {
      mockFindUnique.mockResolvedValue({ signupsEnabled: false });

      await expect(
        assertSignupsAllowed({ path: SSO_CALLBACK }, "ada@example.com"),
      ).resolves.toBeUndefined();
    });

    it("refuses an address outside the domain list", async () => {
      await expect(
        assertSignupsAllowed({ path: SSO_CALLBACK }, "ada@elsewhere.test"),
      ).rejects.toMatchObject({ body: { code: SSO_SIGNUP_REFUSED.code } });
    });

    it("refuses an address it cannot read", async () => {
      mockFindUnique.mockResolvedValue({ signupsEnabled: false });

      await expect(assertSignupsAllowed({ path: SSO_CALLBACK })).rejects.toMatchObject({
        body: { code: SSO_SIGNUP_REFUSED.code },
      });
    });
  });
});
