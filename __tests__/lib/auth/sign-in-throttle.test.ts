import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIError } from "better-auth/api";

const store = new Map<string, number>();
const expires: Array<{ key: string; seconds: number }> = [];
let redisDown = false;

vi.mock("@/lib/redis", () => ({
  getRedis: () => {
    if (redisDown) throw new Error("Redis is down");
    return {
      get: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? null : String(value);
      },
      incr: async (key: string) => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      },
      expire: async (key: string, seconds: number) => {
        expires.push({ key, seconds });
        return 1;
      },
    };
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findFirst: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import {
  isSignInLockedOut,
  recordRefusedSignIn,
  recordSignInFailure,
  SIGN_IN_FAILURE_LIMIT,
  SIGN_IN_FAILURE_WINDOW_SECONDS,
  signInHandle,
} from "@/lib/auth/sign-in-throttle";

const KNOWN_USER = { id: "user-1" };

/** True when the handle resolves to the seeded account, false for anyone else. */
function mockAccountLookup() {
  vi.mocked(prisma.user.findFirst).mockImplementation((async (args: {
    where: { email?: { equals: string }; username?: string };
  }) => {
    const email = args.where.email?.equals;
    if (email !== undefined) return email === "ada@example.com" ? KNOWN_USER : null;
    return args.where.username === "ada" ? KNOWN_USER : null;
  }) as never);
}

describe("signInHandle", () => {
  it("reads the handle each sign-in endpoint carries", () => {
    expect(signInHandle("/sign-in/email", { email: "  Ada@Example.com " })).toEqual({
      field: "email",
      value: "ada@example.com",
    });
    expect(signInHandle("/sign-in/username", { username: "Ada.Lovelace" })).toEqual({
      field: "username",
      value: "ada.lovelace",
    });
  });

  it("ignores every other endpoint", () => {
    expect(signInHandle("/sign-up/email", { email: "ada@example.com" })).toBeNull();
    expect(signInHandle("/two-factor/verify-totp", { code: "123456" })).toBeNull();
    expect(signInHandle("/sign-in/email", { email: 42 })).toBeNull();
  });
});

describe("sign-in failures", () => {
  beforeEach(() => {
    store.clear();
    expires.length = 0;
    redisDown = false;
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAccountLookup();
  });

  it("lets the account try until its attempts are spent", async () => {
    const handle = signInHandle("/sign-in/username", { username: "ada" });
    expect(handle).not.toBeNull();

    for (let attempt = 1; attempt < SIGN_IN_FAILURE_LIMIT; attempt++) {
      expect(await isSignInLockedOut(handle!)).toBe(false);
      await recordSignInFailure(handle!);
    }

    expect(await isSignInLockedOut(handle!)).toBe(false);
    await recordSignInFailure(handle!);
    expect(await isSignInLockedOut(handle!)).toBe(true);
  });

  it("counts the email and the username of one account in one bucket", async () => {
    const byEmail = signInHandle("/sign-in/email", { email: "ada@example.com" });
    const byUsername = signInHandle("/sign-in/username", { username: "ada" });

    for (let attempt = 0; attempt < SIGN_IN_FAILURE_LIMIT; attempt++) {
      await recordSignInFailure(byEmail!);
    }

    // An attacker who knows both handles gets nothing for switching.
    expect(await isSignInLockedOut(byUsername!)).toBe(true);
  });

  it("keeps guessing against an unknown handle in a bucket of its own", async () => {
    const stranger = signInHandle("/sign-in/email", { email: "nobody@example.com" });
    const known = signInHandle("/sign-in/email", { email: "ada@example.com" });

    for (let attempt = 0; attempt < SIGN_IN_FAILURE_LIMIT; attempt++) {
      await recordSignInFailure(stranger!);
    }

    expect(await isSignInLockedOut(stranger!)).toBe(true);
    expect(await isSignInLockedOut(known!)).toBe(false);
  });

  it("starts the window on the first failure and leaves it alone after", async () => {
    const handle = signInHandle("/sign-in/email", { email: "ada@example.com" });

    await recordSignInFailure(handle!);
    await recordSignInFailure(handle!);

    expect(expires).toEqual([{ key: expect.any(String), seconds: SIGN_IN_FAILURE_WINDOW_SECONDS }]);
  });

  it("counts a refusal and nothing else", async () => {
    const refusal = APIError.from("UNAUTHORIZED", { code: "INVALID", message: "Wrong password" });
    await recordRefusedSignIn("/sign-in/email", { email: "ada@example.com" }, refusal);
    expect(
      await isSignInLockedOut(signInHandle("/sign-in/email", { email: "ada@example.com" })!),
    ).toBe(SIGN_IN_FAILURE_LIMIT <= 1);

    store.clear();

    // A sign-in that worked.
    await recordRefusedSignIn(
      "/sign-in/email",
      { email: "ada@example.com" },
      {
        token: "session-token",
        user: { id: "user-1" },
      },
    );
    expect(store.size).toBe(0);
  });

  it("recognises a refusal by its name when the class differs", async () => {
    const refusal = Object.assign(new Error("Wrong password"), { name: "APIError" });
    await recordRefusedSignIn("/sign-in/username", { username: "ada" }, refusal);

    expect([...store.values()]).toEqual([1]);
  });

  it("allows the attempt when Redis is unavailable", async () => {
    const handle = signInHandle("/sign-in/email", { email: "ada@example.com" });
    redisDown = true;

    expect(await isSignInLockedOut(handle!)).toBe(false);
    await expect(recordSignInFailure(handle!)).resolves.toBeUndefined();
  });
});
