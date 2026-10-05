import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { getTestInstance } from "better-auth/test";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { parseTotpSecret } from "@/lib/auth/totp";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_REFRESH_WINDOW_SECONDS,
  sessionCookieAttributes,
} from "@/lib/auth/session-config";

/**
 * Session cookies issued to a browser that just passed a two-factor challenge.
 *
 * An installed app is launched by a cross-site top-level navigation and the
 * user's cookie jar is only as durable as the cookie it holds, so these two
 * properties have to hold for *every* sign-in path — a cookie that is withheld
 * on launch (`SameSite=Strict`) or dropped when the browser closes (no
 * `Max-Age`) makes 2FA look like "log in again on every cold start".
 */
const SESSION_COOKIE = "better-auth.session_token";

describe("session cookie issued after 2FA (integration)", () => {
  async function buildAuth() {
    return getTestInstance({
      plugins: [twoFactor({ issuer: "Saale" })],
      session: {
        expiresIn: SESSION_EXPIRES_IN_SECONDS,
        updateAge: SESSION_REFRESH_WINDOW_SECONDS,
      },
      advanced: {
        // Exactly what `src/auth.ts` configures.
        defaultCookieAttributes: sessionCookieAttributes(),
      },
    });
  }

  type Instance = Awaited<ReturnType<typeof buildAuth>>;

  const AUTH_URL = "http://localhost:3000/api/auth";

  function post(instance: Instance, path: string, body: unknown, cookie?: string) {
    return instance.auth.handler(
      new Request(`${AUTH_URL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  /** The `Set-Cookie` value for `name`, with its attributes. */
  function setCookie(response: Response, name: string): string | undefined {
    return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  }

  /** The attributes of a `Set-Cookie` value, keyed by name. Case is ignored:
   * attribute names and values (`SameSite=Lax`) are case-insensitive. */
  function attributes(cookie: string): Record<string, string> {
    const [, ...pairs] = cookie.split(";");
    return Object.fromEntries(
      pairs.map((pair) => {
        const [key, value = ""] = pair.trim().split("=");
        return [key!.toLowerCase(), value.toLowerCase()];
      }),
    );
  }

  /** A cookie header carrying only the named cookies, as a browser would send. */
  function cookieHeader(...cookies: Array<string | undefined>): string {
    return cookies
      .filter((cookie): cookie is string => Boolean(cookie))
      .map((cookie) => cookie.split(";")[0]!)
      .join("; ");
  }

  async function enableTotp(instance: Instance, cookie: string) {
    const enable = await post(
      instance,
      "/two-factor/enable",
      {
        password: instance.testUser.password,
        method: "totp",
      },
      cookie,
    );
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = new TextDecoder().decode(base32.decode(parseTotpSecret(totpURI)!));
    const verify = await post(
      instance,
      "/two-factor/verify-totp",
      {
        code: await createOTP(secret, { digits: 6, period: 30 }).totp(),
      },
      cookie,
    );
    expect(verify.status).toBe(200);
    return secret;
  }

  /** Sign in with a password, returning the in-flight 2FA challenge cookies. */
  async function challenge(instance: Instance) {
    const signIn = await post(instance, "/sign-in/email", {
      email: instance.testUser.email,
      password: instance.testUser.password,
    });
    const challengeCookies = cookieHeader(
      setCookie(signIn, "better-auth.two_factor"),
      setCookie(signIn, "better-auth.dont_remember"),
    );
    return { signIn, challengeCookies };
  }

  async function enabledInstance() {
    const instance = await buildAuth();
    const { headers } = await instance.signInWithUser(
      instance.testUser.email,
      instance.testUser.password,
    );
    const secret = await enableTotp(instance, headers.get("cookie")!);
    return { instance, secret };
  }

  it("survives an app restart and is sent on an installed-app launch", async () => {
    const { instance, secret } = await enabledInstance();

    // Password step: no live session may leak before the second factor.
    const { signIn, challengeCookies } = await challenge(instance);
    expect((await signIn.clone().json()).twoFactorRedirect).toBe(true);
    const preSession = setCookie(signIn, SESSION_COOKIE);
    expect(preSession).toBeTruthy();
    expect(preSession).toContain(`${SESSION_COOKIE}=;`);
    expect(attributes(preSession!)["max-age"]).toBe("0");

    const verified = await post(
      instance,
      "/two-factor/verify-totp",
      {
        code: await createOTP(secret, { digits: 6, period: 30 }).totp(),
      },
      challengeCookies,
    );
    expect(verified.status).toBe(200);

    const session = setCookie(verified, SESSION_COOKIE);
    expect(session).toBeTruthy();
    const attrs = attributes(session!);
    // Persistent: closing the app must not discard the session.
    expect(attrs["max-age"]).toBe(String(SESSION_EXPIRES_IN_SECONDS));
    expect(attrs["expires"]).toBeUndefined();
    // Lax, not Strict: the launch navigation is cross-site.
    expect(attrs["samesite"]).toBe("lax");
    expect(attrs["httponly"]).toBeDefined();

    // The cookie alone — nothing else from the verify round-trip — reopens the session.
    const restored = await instance.auth.api.getSession({
      headers: { cookie: cookieHeader(session) },
    });
    expect(restored?.user.id).toBeTruthy();
    expect(restored?.session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("issues the same persistent cookie when a backup code is used", async () => {
    const instance = await buildAuth();
    const { headers } = await instance.signInWithUser(
      instance.testUser.email,
      instance.testUser.password,
    );
    const cookie = headers.get("cookie")!;

    const enable = await post(
      instance,
      "/two-factor/enable",
      {
        password: instance.testUser.password,
        method: "totp",
      },
      cookie,
    );
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const secret = new TextDecoder().decode(base32.decode(parseTotpSecret(totpURI)!));
    await post(
      instance,
      "/two-factor/verify-totp",
      {
        code: await createOTP(secret, { digits: 6, period: 30 }).totp(),
      },
      cookie,
    );

    const { challengeCookies } = await challenge(instance);
    const verified = await post(
      instance,
      "/two-factor/verify-backup-code",
      {
        code: backupCodes[0],
      },
      challengeCookies,
    );
    expect(verified.status).toBe(200);

    const attrs = attributes(setCookie(verified, SESSION_COOKIE)!);
    expect(attrs["max-age"]).toBe(String(SESSION_EXPIRES_IN_SECONDS));
    expect(attrs["samesite"]).toBe("lax");

    const restored = await instance.auth.api.getSession({
      headers: { cookie: cookieHeader(setCookie(verified, SESSION_COOKIE)) },
    });
    expect(restored?.user.id).toBeTruthy();
  });
});
