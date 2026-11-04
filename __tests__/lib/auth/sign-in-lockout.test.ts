/**
 * The lockout that stands in for the per-address limit, against the production
 * auth options and the harness's in-memory database.
 *
 * The per-address limit believes `x-forwarded-for`, which the caller writes, so
 * a wrong password only costs something when it is counted against the account.
 * That is what this pins: the attempts add up, and the next guess is refused
 * before any password is checked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Every attempt here comes from one address, and better-auth's own limiter
// would answer 429 long before the account's budget runs out.
process.env.AUTH_RATE_LIMIT = "off";

const counts = new Map<string, number>();

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => {
      const value = counts.get(key);
      return value === undefined ? null : String(value);
    },
    incr: async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async () => 1,
  }),
}));

// The throttle resolves a handle to the account behind it; everything else the
// production options touch is the harness database.
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: async (args: { where: { username?: string; email?: { equals: string } } }) => {
        const handle = args.where.username ?? args.where.email?.equals;
        return handle === "throttled" || handle === "throttled@example.com"
          ? { id: "user-throttled" }
          : null;
      },
      count: async () => 2,
      update: async () => ({}),
    },
    role: { createMany: async () => ({}), findMany: async () => [] },
    adminSettings: { findUnique: async () => ({ signupsEnabled: true }) },
  },
}));

import { getTestInstance } from "better-auth/test";
import type { BetterAuthOptions } from "better-auth";
import { usernameClient } from "better-auth/client/plugins";

const { auth } = await import("@/auth");
const { SIGN_IN_FAILURE_LIMIT } = await import("@/lib/auth/sign-in-throttle");

const PASSWORD = "test123456";

type LockoutClient = {
  signIn: {
    username(input: { username: string; password: string }): Promise<{
      data: unknown;
      error: { code?: string; message?: string } | null;
    }>;
  };
  signUp: {
    email(input: {
      name: string;
      email: string;
      password: string;
      username?: string;
    }): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  };
};

async function buildInstance() {
  const { database: _adapter, ...productionOptions } = auth.options;

  return getTestInstance(
    productionOptions as Partial<BetterAuthOptions>,
    {
      clientOptions: { plugins: [usernameClient({ displayUsername: false })] },
      testUser: { username: "throttled" },
    } as unknown as Parameters<typeof getTestInstance>[1],
  );
}

describe("sign-in lockout (integration)", () => {
  beforeEach(() => {
    counts.clear();
  });

  it("refuses the next guess once an account has spent its attempts", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as LockoutClient;

    for (let attempt = 0; attempt < SIGN_IN_FAILURE_LIMIT; attempt++) {
      const { error } = await client.signIn.username({
        username: "throttled",
        password: "wrong-password",
      });
      expect(error?.code).not.toBe("TOO_MANY_ATTEMPTS");
    }

    // The right password is refused too: the account is locked, not the
    // attempt's content.
    const locked = await client.signIn.username({ username: "throttled", password: PASSWORD });

    expect(locked.data).toBeNull();
    expect(locked.error?.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("leaves an account alone until it has failures of its own", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as LockoutClient;

    for (let attempt = 0; attempt < SIGN_IN_FAILURE_LIMIT; attempt++) {
      await client.signIn.username({ username: "throttled", password: "wrong-password" });
    }

    // A fresh account has its own budget.
    const elsewhere = await client.signIn.username({
      username: "someone-else",
      password: "wrong-password",
    });
    expect(elsewhere.error?.code).not.toBe("TOO_MANY_ATTEMPTS");
  });

  it("counts a wrong password and not a right one", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as LockoutClient;

    const signedUp = await client.signUp.email({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: PASSWORD,
      username: "grace",
    });
    expect(signedUp.error).toBeNull();

    for (let attempt = 0; attempt < SIGN_IN_FAILURE_LIMIT + 1; attempt++) {
      const { error } = await client.signIn.username({ username: "grace", password: PASSWORD });
      expect(error).toBeNull();
    }
  });
});
