import { getTestInstance } from "better-auth/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_REFRESH_WINDOW_SECONDS,
  isSecureCookie,
  sessionCookieAttributes,
} from "@/lib/auth/session-config";

const DAY_SECONDS = 60 * 60 * 24;
const YEAR_SECONDS = 365 * DAY_SECONDS;

describe("session lifetime config", () => {
  it("sessions persist for one year", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(YEAR_SECONDS);
  });

  it("refresh window is one day and shorter than the TTL", () => {
    expect(SESSION_REFRESH_WINDOW_SECONDS).toBe(DAY_SECONDS);
    expect(SESSION_REFRESH_WINDOW_SECONDS).toBeLessThan(SESSION_EXPIRES_IN_SECONDS);
  });
});

const originalEnv: Record<string, string | undefined> = {
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  NODE_ENV: process.env.NODE_ENV,
};

describe("isSecureCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // Restore the originals so other test files see the same env.
    Object.assign(process.env, originalEnv);
  });

  function setEnv(url: string | undefined, nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    if (url === undefined) vi.stubEnv("BETTER_AUTH_URL", "");
    else vi.stubEnv("BETTER_AUTH_URL", url);
  }

  it.each([
    ["https://saale.example.com", true],
    ["https://saale.example.com/", true],
    ["HTTP://localhost:3630", false],
    ["http://192.168.1.10:3630", false],
  ])("uses the scheme of BETTER_AUTH_URL (%s)", (url, expected) => {
    setEnv(url, "production");
    expect(isSecureCookie()).toBe(expected);
  });

  it.each([
    ["production", true],
    ["development", false],
  ] as const)("falls back to NODE_ENV when no URL is set (%s)", (nodeEnv, expected) => {
    setEnv(undefined, nodeEnv);
    expect(isSecureCookie()).toBe(expected);
  });
});

describe("sessionCookieAttributes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.assign(process.env, originalEnv);
  });

  it("stays sendable when an installed app is launched", () => {
    // A cold start of an installed app is a cross-site top-level navigation.
    // SameSite=Strict is withheld on it, which signs the user out on every
    // launch — the whole point of keeping this cookie Lax.
    expect(sessionCookieAttributes().sameSite).toBe("lax");
  });

  it.each([
    ["https://saale.example.com", true],
    ["http://192.168.1.10:3630", false],
  ])("derives the Secure flag from the served scheme (%s)", (url, expected) => {
    vi.stubEnv("BETTER_AUTH_URL", url);
    expect(sessionCookieAttributes().secure).toBe(expected);
  });
});

/**
 * End-to-end against a real better-auth instance configured exactly like
 * `src/auth.ts`: verifies the issued session actually lives a year and that
 * the sliding window extends it on activity.
 */
describe("session lifetime (integration)", () => {
  async function buildAuth() {
    return getTestInstance({
      session: {
        expiresIn: SESSION_EXPIRES_IN_SECONDS,
        updateAge: SESSION_REFRESH_WINDOW_SECONDS,
      },
    });
  }

  type Instance = Awaited<ReturnType<typeof buildAuth>>;

  async function sessionRow(instance: Instance, userId: string) {
    const rows = (await instance.db.findMany({ model: "session" })) as Array<{
      id: string;
      userId: string;
      token: string;
      createdAt: Date;
      updatedAt: Date;
      expiresAt: Date;
    }>;
    return rows.filter((row) => row.userId === userId).at(-1);
  }

  it("issues sessions with a one-year expiry", async () => {
    const instance = await buildAuth();
    const { testUser } = instance;
    const { headers } = await instance.signInWithUser(testUser.email, testUser.password);

    const users = (await instance.db.findMany({ model: "user" })) as Array<{ id: string }>;
    const user = users[0];
    if (!user) throw new Error("test user was not created");
    const row = await sessionRow(instance, user.id);
    expect(row).toBeTruthy();

    const delta = new Date(row!.expiresAt).getTime() - Date.now();
    // Within a couple of days of one year: catches unit mix-ups (ms vs s)
    // in both directions.
    expect(delta).toBeGreaterThan(363 * DAY_SECONDS * 1000);
    expect(delta).toBeLessThan(367 * DAY_SECONDS * 1000);
    expect(headers.get("cookie")).toBeTruthy();
  });

  it("slides the expiry forward when the session is used past the refresh window", async () => {
    const instance = await buildAuth();
    const { testUser, auth } = instance;
    const { headers } = await instance.signInWithUser(testUser.email, testUser.password);
    const cookie = headers.get("cookie")!;

    const users = (await instance.db.findMany({ model: "user" })) as Array<{ id: string }>;
    const user = users[0];
    if (!user) throw new Error("test user was not created");
    const before = (await sessionRow(instance, user.id))!;

    // Simulate a session that was created two days ago: past the 1-day
    // refresh window, but far from expiry.
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_SECONDS * 1000);
    await instance.db.update({
      model: "session",
      where: [{ field: "id", value: before.id }],
      update: {
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
        expiresAt: new Date(twoDaysAgo.getTime() + SESSION_EXPIRES_IN_SECONDS * 1000),
      },
    });

    const session = await auth.api.getSession({ headers: { cookie } });
    expect(session?.session).toBeTruthy();

    const after = (await sessionRow(instance, user.id))!;
    const delta = new Date(after.expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(363 * DAY_SECONDS * 1000);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(twoDaysAgo.getTime());
  });

  it("does not refresh a fresh session within the refresh window", async () => {
    const instance = await buildAuth();
    const { testUser, auth } = instance;
    const { headers } = await instance.signInWithUser(testUser.email, testUser.password);
    const cookie = headers.get("cookie")!;

    const users = (await instance.db.findMany({ model: "user" })) as Array<{ id: string }>;
    const user = users[0];
    if (!user) throw new Error("test user was not created");
    const before = (await sessionRow(instance, user.id))!;

    const session = await auth.api.getSession({ headers: { cookie } });
    expect(session?.session).toBeTruthy();

    const after = (await sessionRow(instance, user.id))!;
    // Within the window: no write, updatedAt untouched.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });
});
