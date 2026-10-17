/**
 * Usernames as the credential handle, end to end against the production auth
 * options — plugins, hooks, sign-up guard and validation included — running on
 * the test harness's in-memory database.
 *
 * The behaviours pinned here all sit in wiring that no unit test can see:
 * sign-ups without a handle must fail, the stored handle is the normalized one,
 * a taken handle is refused, and both the username and the email sign-in routes
 * have to keep working (the login form picks between them by input shape).
 */

import { describe, expect, it, vi } from "vitest";
import { getTestInstance } from "better-auth/test";
import type { BetterAuthOptions } from "better-auth";
import { usernameClient } from "better-auth/client/plugins";

// The production options run the "first user becomes admin" database hook
// through the app's prisma client. Nothing here should touch a real database.
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: async () => 2, update: async () => ({}) },
    adminSettings: { findUnique: async () => ({ signupsEnabled: true }) },
  },
}));

import { auth } from "@/auth";

const PASSWORD = "test123456";
const TEST_HANDLE = "testuser";

/** The harness client is typed from its own options; only `signIn` is used. */
type UsernameAuthClient = {
  signIn: {
    username(input: { username: string; password: string }): Promise<{
      data: { user: { username?: string | null } } | null;
      error: { code?: string; message?: string } | null;
    }>;
    email(input: { email: string; password: string }): Promise<{
      data: { user: { email: string } } | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
  signUp: {
    email(input: { name: string; email: string; password: string; username?: string }): Promise<{
      data: { user: { username?: string | null } } | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
  admin: {
    createUser(
      input: {
        name: string;
        email: string;
        password?: string;
        role?: string;
        data?: Record<string, unknown>;
      } & { fetchOptions?: { headers?: Headers } },
    ): Promise<{
      data: { user: { username?: string | null } } | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
};

async function buildInstance() {
  // Swap the prisma adapter for the harness database; every other option is
  // exactly what production runs.
  const { database: _adapter, ...productionOptions } = auth.options;

  // The harness types `testUser` from better-auth's core user model, which has
  // no username — but the plugin refuses to create the test account without one.
  const config = {
    clientOptions: { plugins: [usernameClient({ displayUsername: false })] },
    testUser: { username: TEST_HANDLE },
  } as unknown as Parameters<typeof getTestInstance>[1];

  return getTestInstance(productionOptions as Partial<BetterAuthOptions>, config);
}

type Instance = Awaited<ReturnType<typeof buildInstance>>;

function clientOf(instance: Instance): UsernameAuthClient {
  return instance.client as unknown as UsernameAuthClient;
}

async function storedHandle(instance: Instance, email: string): Promise<string | null> {
  const users = (await instance.db.findMany({ model: "user" })) as Array<{
    email: string;
    username?: string | null;
  }>;
  return users.find((user) => user.email === email)?.username ?? null;
}

describe("username sign-in (integration)", () => {
  it("refuses a sign-up without a username", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    const { data, error } = await client.signUp.email({
      name: "Ada Lovelace",
      email: "no-handle@example.com",
      password: PASSWORD,
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("USERNAME_REQUIRED");
    expect(await storedHandle(instance, "no-handle@example.com")).toBeNull();
  });

  it("stores the normalized handle and signs in with it whatever the casing", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    const signUp = await client.signUp.email({
      name: "Ada.Lovelace",
      email: "ada@example.com",
      password: PASSWORD,
      username: "Ada.Lovelace",
    });
    expect(signUp.error).toBeNull();
    expect(await storedHandle(instance, "ada@example.com")).toBe("ada.lovelace");

    const signIn = await client.signIn.username({
      username: "  ADA.LOVELACE ",
      password: PASSWORD,
    });
    expect(signIn.error).toBeNull();
    expect(signIn.data?.user.username).toBe("ada.lovelace");
  });

  it.each(["ada lovelace", "ada@example.com", "ab", "a".repeat(31), "ada!"])(
    "refuses %j as a username",
    async (username) => {
      const instance = await buildInstance();
      const client = clientOf(instance);

      const { error } = await client.signUp.email({
        name: username,
        email: "invalid@example.com",
        password: PASSWORD,
        username,
      });

      expect(error?.code).toBeTruthy();
      expect(await storedHandle(instance, "invalid@example.com")).toBeNull();
    },
  );

  it("refuses a handle another account already holds", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    const first = await client.signUp.email({
      name: "Ada",
      email: "first@example.com",
      password: PASSWORD,
      username: "ada",
    });
    expect(first.error).toBeNull();

    // Same handle in a different casing is the same handle.
    const second = await client.signUp.email({
      name: "Ada",
      email: "second@example.com",
      password: PASSWORD,
      username: "Ada",
    });
    expect(second.error?.code).toBe("USERNAME_IS_ALREADY_TAKEN");
    expect(await storedHandle(instance, "second@example.com")).toBeNull();
  });

  it("requires a handle when an admin creates a user", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    // Admin endpoints need an admin session: promote the harness's user.
    const users = (await instance.db.findMany({ model: "user" })) as Array<{
      id: string;
      email: string;
    }>;
    const testUser = users.find((user) => user.email === "test@test.com");
    if (!testUser) throw new Error("test user was not created");
    await instance.db.update({
      model: "user",
      where: [{ field: "id", value: testUser.id }],
      update: { role: "admin" },
    });
    const { headers } = await instance.signInWithTestUser();

    const missing = await client.admin.createUser({
      name: "Ada Lovelace",
      email: "admin-made@example.com",
      password: PASSWORD,
      role: "user",
      fetchOptions: { headers },
    });
    expect(missing.error?.code).toBe("USERNAME_REQUIRED");

    const created = await client.admin.createUser({
      name: "ada.lovelace",
      email: "admin-made@example.com",
      password: PASSWORD,
      role: "user",
      data: { username: "Ada.Lovelace" },
      fetchOptions: { headers },
    });
    expect(created.error).toBeNull();
    expect(await storedHandle(instance, "admin-made@example.com")).toBe("ada.lovelace");
  });

  it("keeps email sign-in working for accounts that have a handle", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    await client.signUp.email({
      name: "ada.lovelace",
      email: "both@example.com",
      password: PASSWORD,
      username: "ada.lovelace",
    });

    const signIn = await client.signIn.email({ email: "both@example.com", password: PASSWORD });
    expect(signIn.error).toBeNull();
    expect(signIn.data?.user.email).toBe("both@example.com");
  });

  it("still demands the second factor on the username route", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    await client.signUp.email({
      name: "ada.lovelace",
      email: "mfa@example.com",
      password: PASSWORD,
      username: "ada.lovelace",
    });

    const users = (await instance.db.findMany({ model: "user" })) as Array<{
      id: string;
      email: string;
    }>;
    const user = users.find((row) => row.email === "mfa@example.com");
    if (!user) throw new Error("user was not created");
    // What the two-factor plugin's own enable flow sets.
    await instance.db.update({
      model: "user",
      where: [{ field: "id", value: user.id }],
      update: { twoFactorEnabled: true },
    });

    const sessionsForUser = async () => {
      const sessions = (await instance.db.findMany({ model: "session" })) as Array<{
        userId: string;
      }>;
      return sessions.filter((session) => session.userId === user.id);
    };
    // Sign-up itself issues a session; the 2FA-pending sign-in must add none.
    const before = (await sessionsForUser()).length;

    const signIn = await client.signIn.username({ username: "ada.lovelace", password: PASSWORD });
    expect(signIn.data).toMatchObject({ twoFactorRedirect: true });

    // The credential session is torn down again: nothing is signed in yet.
    expect(await sessionsForUser()).toHaveLength(before);
  });

  it("refuses a wrong password on the username route", async () => {
    const instance = await buildInstance();
    const client = clientOf(instance);

    await client.signUp.email({
      name: "ada.lovelace",
      email: "wrong-pass@example.com",
      password: PASSWORD,
      username: "ada.lovelace",
    });

    const signIn = await client.signIn.username({
      username: "ada.lovelace",
      password: "not-the-password",
    });
    expect(signIn.data).toBeNull();
    expect(signIn.error?.code).toBe("INVALID_USERNAME_OR_PASSWORD");
  });
});
