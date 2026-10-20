import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { getTestInstance } from "better-auth/test";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";

import { parseTotpSecret } from "@/lib/auth/totp";
import { revokeSessionsOnTwoFactorEnable } from "@/lib/auth/two-factor";

describe("revokeSessionsOnTwoFactorEnable (guard)", () => {
  const makeContext = (path: string) => {
    const deleteUserSessions = vi.fn().mockResolvedValue(undefined);
    const context = {
      path,
      context: { internalAdapter: { deleteUserSessions } },
    };
    return { context, deleteUserSessions };
  };

  it("skips updates that do not enable 2FA", async () => {
    const { context, deleteUserSessions } = makeContext("/two-factor/verify-totp");
    await revokeSessionsOnTwoFactorEnable({ id: "user-1", twoFactorEnabled: false }, context);
    expect(deleteUserSessions).not.toHaveBeenCalled();
  });

  it("skips when there is no endpoint context", async () => {
    const deleteUserSessions = vi.fn().mockResolvedValue(undefined);
    const context = {
      path: "/two-factor/verify-totp",
      context: { internalAdapter: { deleteUserSessions } },
    };
    await revokeSessionsOnTwoFactorEnable({ id: "user-1", twoFactorEnabled: true }, null);
    expect(deleteUserSessions).not.toHaveBeenCalled();
    // Sanity: the same user data on a null context is the only skipped case;
    // a real context still revokes.
    await revokeSessionsOnTwoFactorEnable({ id: "user-1", twoFactorEnabled: true }, context);
    expect(deleteUserSessions).toHaveBeenCalledWith("user-1");
  });

  it.each(["/update-user", "/sign-in/email", "/two-factor/disable"])(
    "skips non-enable endpoint %s",
    async (path) => {
      const { context, deleteUserSessions } = makeContext(path);
      await revokeSessionsOnTwoFactorEnable({ id: "user-1", twoFactorEnabled: true }, context);
      expect(deleteUserSessions).not.toHaveBeenCalled();
    },
  );

  it.each(["/two-factor/enable", "/two-factor/verify-totp"])(
    "revokes all sessions for the user on %s",
    async (path) => {
      const { context, deleteUserSessions } = makeContext(path);
      await revokeSessionsOnTwoFactorEnable({ id: "user-1", twoFactorEnabled: true }, context);
      expect(deleteUserSessions).toHaveBeenCalledWith("user-1");
    },
  );
});

/**
 * End-to-end session invalidation against a real better-auth instance with the
 * twoFactor plugin and the production hook wired in:
 *
 * - enabling 2FA must sign out every pre-existing session (they never passed
 *   the 2FA challenge) while re-issuing one for the enabling browser;
 * - changing the password with `revokeOtherSessions` must sign out other
 *   devices while keeping the current browser signed in;
 * - a plain profile update must not touch any session.
 */
describe("session invalidation (integration)", () => {
  async function buildAuth() {
    return getTestInstance({
      plugins: [twoFactor({ issuer: "Saale" })],
      databaseHooks: {
        user: {
          update: {
            after: async (user, context) => {
              await revokeSessionsOnTwoFactorEnable(user, context);
            },
          },
        },
      },
    });
  }

  type Instance = Awaited<ReturnType<typeof buildAuth>>;

  // The test instance's client is a dynamic path proxy at runtime, so the
  // two-factor namespace works even though the declared client type omits
  // the plugin. Cast to the minimal surface the tests use.
  type TwoFactorClientSurface = {
    twoFactor: {
      enable(input: { password: string; fetchOptions?: Record<string, unknown> }): Promise<{
        data: { totpURI: string } | null;
        error: { code: string; message: string } | null;
      }>;
      verifyTotp(input: { code: string; fetchOptions?: Record<string, unknown> }): Promise<{
        data: { token: string } | null;
        error: { code: string; message: string } | null;
      }>;
    };
  };

  async function sessionsForUser(instance: Instance, userId: string) {
    const rows = (await instance.db.findMany({ model: "session" })) as Array<{
      userId: string;
      token: string;
    }>;
    return rows.filter((row) => row.userId === userId);
  }

  // The test instance's `testUser` object carries no id  the server assigns
  // it at sign-up  so resolve it from the user table.
  async function userId(instance: Instance): Promise<string> {
    const users = (await instance.db.findMany({ model: "user" })) as Array<{ id: string }>;
    const user = users[0];
    if (!user) throw new Error("test user was not created");
    return user.id;
  }

  it("enabling 2FA signs out other devices and re-issues the enabling session", async () => {
    const instance = await buildAuth();
    const { auth, testUser, signInWithUser, sessionSetter } = instance;
    const client = instance.client as typeof instance.client & TwoFactorClientSurface;

    // Two devices with active sessions (plus the test user's sign-up session,
    // which is also pre-2FA and must be wiped).
    const uid = await userId(instance);
    const baseline = (await sessionsForUser(instance, uid)).length;
    const { headers: deviceA } = await signInWithUser(testUser.email, testUser.password);
    const { headers: deviceB } = await signInWithUser(testUser.email, testUser.password);
    const cookieA = () => deviceA.get("cookie")!;
    const cookieB = () => deviceB.get("cookie")!;
    expect((await sessionsForUser(instance, uid)).length).toBe(baseline + 2);

    // Device A enables TOTP.
    const { data: enableData, error: enableError } = await client.twoFactor.enable({
      password: testUser.password,
      fetchOptions: { headers: { cookie: cookieA() } },
    });
    expect(enableError).toBeNull();
    expect(enableData?.totpURI).toContain("otpauth://");

    // Completing setup re-issues device A's session and wipes every other one.
    const secret = new TextDecoder().decode(base32.decode(parseTotpSecret(enableData!.totpURI)!));
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const { data: verifyData, error: verifyError } = await client.twoFactor.verifyTotp({
      code,
      fetchOptions: { headers: { cookie: cookieA() }, onSuccess: sessionSetter(deviceA) },
    });
    expect(verifyError).toBeNull();
    expect(verifyData).toBeTruthy();

    // Device A holds the freshly issued session, device B is signed out,
    // and only that one session survives.
    const sessionA = await auth.api.getSession({ headers: { cookie: cookieA() } });
    expect(sessionA?.session).toBeTruthy();
    expect(sessionA?.user.twoFactorEnabled).toBe(true);
    const sessionB = await auth.api.getSession({ headers: { cookie: cookieB() } });
    expect(sessionB).toBeNull();
    const remaining = await sessionsForUser(instance, uid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.token).toBe(sessionA!.session.token);
  });

  it("changing the password signs out other devices and invalidates the old password", async () => {
    const instance = await buildAuth();
    const { client, auth, testUser, signInWithUser, sessionSetter } = instance;

    const uid = await userId(instance);
    const baseline = (await sessionsForUser(instance, uid)).length;
    const { headers: deviceA } = await signInWithUser(testUser.email, testUser.password);
    const { headers: deviceB } = await signInWithUser(testUser.email, testUser.password);
    const cookieA = () => deviceA.get("cookie")!;
    const cookieB = () => deviceB.get("cookie")!;
    expect((await sessionsForUser(instance, uid)).length).toBe(baseline + 2);

    const { error } = await client.changePassword({
      currentPassword: testUser.password,
      newPassword: "new-password-123",
      revokeOtherSessions: true,
      fetchOptions: { headers: { cookie: cookieA() }, onSuccess: sessionSetter(deviceA) },
    });
    expect(error).toBeNull();

    // Device A stays signed in via the re-issued session, device B is out,
    // and only that one session survives.
    const sessionA = await auth.api.getSession({ headers: { cookie: cookieA() } });
    expect(sessionA?.session).toBeTruthy();
    const sessionB = await auth.api.getSession({ headers: { cookie: cookieB() } });
    expect(sessionB).toBeNull();
    const remaining = await sessionsForUser(instance, uid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.token).toBe(sessionA!.session.token);

    // The old password no longer signs in, the new one does.
    const oldSignIn = await client.signIn.email({
      email: testUser.email,
      password: testUser.password,
    });
    expect(oldSignIn.error?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    const newSignIn = await client.signIn.email({
      email: testUser.email,
      password: "new-password-123",
    });
    expect(newSignIn.error).toBeNull();
    expect(newSignIn.data?.token).toBeTruthy();
  });

  it("does not revoke sessions on a plain profile update", async () => {
    const instance = await buildAuth();
    const { client, auth, testUser, signInWithUser } = instance;

    const uid = await userId(instance);
    const { headers: deviceA } = await signInWithUser(testUser.email, testUser.password);
    const { headers: deviceB } = await signInWithUser(testUser.email, testUser.password);
    const before = (await sessionsForUser(instance, uid)).length;

    const { error } = await client.updateUser({
      name: "Renamed User",
      fetchOptions: { headers: { cookie: deviceA.get("cookie")! } },
    });
    expect(error).toBeNull();

    const sessionA = await auth.api.getSession({ headers: { cookie: deviceA.get("cookie")! } });
    const sessionB = await auth.api.getSession({ headers: { cookie: deviceB.get("cookie")! } });
    expect(sessionA?.user.name).toBe("Renamed User");
    expect(sessionB?.session).toBeTruthy();
    expect((await sessionsForUser(instance, uid)).length).toBe(before);
  });
});
