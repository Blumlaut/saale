/**
 * The sign-up setting, enforced by the production auth options.
 *
 * Nothing else covers this: the register form asks the same question, but a
 * form is not a gate — the setting has to hold for the API too, including the
 * paths that create an account without ever showing a form.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTestInstance } from "better-auth/test";
import type { BetterAuthOptions } from "better-auth";
import { usernameClient } from "better-auth/client/plugins";

// What the production hooks read for their decisions, held in one place so a
// test can move the instance's state around.
const { state } = vi.hoisted(() => ({
  state: { signupsEnabled: true, userCount: 2 },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: async () => state.userCount, update: async () => ({}) },
    adminSettings: { findUnique: async () => ({ signupsEnabled: state.signupsEnabled }) },
  },
}));

import { auth } from "@/auth";
import { SIGNUPS_DISABLED_ERROR } from "@/lib/auth/signups";

const PASSWORD = "test123456";
const TEST_HANDLE = "testuser";

type SignUpClient = {
  signUp: {
    email(input: { name: string; email: string; password: string; username?: string }): Promise<{
      data: { user: { email: string } } | null;
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
      data: { user: { email: string } } | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
};

async function buildInstance() {
  // Every option is production's; only the database is swapped for the
  // harness's in-memory one.
  const { database: _adapter, ...productionOptions } = auth.options;

  const config = {
    clientOptions: { plugins: [usernameClient({ displayUsername: false })] },
    testUser: { username: TEST_HANDLE },
  } as unknown as Parameters<typeof getTestInstance>[1];

  return getTestInstance(productionOptions as Partial<BetterAuthOptions>, config);
}

beforeEach(() => {
  state.signupsEnabled = true;
  state.userCount = 2;
});

describe("sign-up setting", () => {
  it("refuses a sign-up while an admin has sign-ups off", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as SignUpClient;

    state.signupsEnabled = false;

    const { data, error } = await client.signUp.email({
      name: "Ada Lovelace",
      email: "closed@example.com",
      password: PASSWORD,
      username: "ada",
    });

    expect(data).toBeNull();
    expect(error?.code).toBe(SIGNUPS_DISABLED_ERROR.code);

    const stored = (await instance.db.findMany({ model: "user" })) as Array<{ email: string }>;
    expect(stored.some((user) => user.email === "closed@example.com")).toBe(false);
  });

  it("keeps letting existing accounts sign in", async () => {
    const instance = await buildInstance();
    state.signupsEnabled = false;

    const { headers } = await instance.signInWithTestUser();

    expect(headers.get("cookie")).toContain("better-auth.session_token");
  });

  it("still lets an admin create an account while sign-ups are off", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as SignUpClient;

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

    state.signupsEnabled = false;

    const { data, error } = await client.admin.createUser({
      name: "Ada Lovelace",
      email: "admin-made@example.com",
      password: PASSWORD,
      role: "user",
      data: { username: "ada.lovelace" },
      fetchOptions: { headers },
    });

    expect(error).toBeNull();
    expect(data?.user.email).toBe("admin-made@example.com");
  });

  it("lets the first account be created on an empty instance", async () => {
    const instance = await buildInstance();
    const client = instance.client as unknown as SignUpClient;

    state.signupsEnabled = false;
    state.userCount = 0;

    const { data, error } = await client.signUp.email({
      name: "Ada Lovelace",
      email: "bootstrap@example.com",
      password: PASSWORD,
      username: "ada",
    });

    expect(error).toBeNull();
    expect(data?.user.email).toBe("bootstrap@example.com");
  });
});
