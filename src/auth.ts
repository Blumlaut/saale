// Must be imported before betterAuth() is constructed: Next dev can evaluate
// this module before .env is loaded, in which case better-auth would fall
// back to its hardcoded default secret and cookies would be signed with a
// different secret than other module instances. intermittently invalidating
// sessions.
import "dotenv/config";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { username } from "better-auth/plugins/username";
import { prisma } from "@/lib/db";
import { saaleAccessControl } from "@/lib/permissions/statements";
import { AUTH_ROLES, loadRoleDefinitions } from "@/lib/permissions/role-cache";
import { revokeSessionsOnTwoFactorEnable } from "@/lib/auth/two-factor";
import { destroyUserSandbox } from "@/lib/sandbox/teardown";
import { ADMIN_CREATE_USER_PATH, assertSignupsAllowed } from "@/lib/auth/signups";
import { getAccountPolicy, PASSWORD_FIELD_BY_PATH } from "@/lib/auth/password-policy";
import {
  isSignInLockedOut,
  recordRefusedSignIn,
  SIGN_IN_LOCKED_ERROR,
  signInHandle,
} from "@/lib/auth/sign-in-throttle";
import { linkTelegramFromOidcLogin, telegramOidcPlugins } from "@/lib/telegram/oidc";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REQUIRED_ERROR,
  isValidUsername,
  normalizeUsername,
} from "@/lib/auth/username";
import {
  accountPolicyProblem,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_REFRESH_WINDOW_SECONDS,
  sessionCookieAttributes,
} from "@/lib/auth/session-config";

/** Origins that may send auth requests, comma separated in `AUTH_TRUSTED_ORIGINS`. */
function trustedOriginsFromEnv(): string[] {
  return (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  // A preview hostname is under the deployment's own domain and changes per
  // port, so the wildcard is configured once rather than per host.
  trustedOrigins: trustedOriginsFromEnv(),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
  },
  socialProviders: {},
  // Security settings
  advanced: {
    defaultCookieAttributes: sessionCookieAttributes(),
  },
  // Session settings. one year, sliding: activity older than the refresh
  // window resets the expiry to the full TTL (see session-config.ts).
  session: {
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_REFRESH_WINDOW_SECONDS,
  },
  // The limit keys on the client IP, and the e2e suite reaches the server from
  // one address: every run would answer 429 halfway through.
  rateLimit: { enabled: process.env.AUTH_RATE_LIMIT !== "off" },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Counted against the account, because the per-address limit believes a
      // header the caller sets.
      const signIn = signInHandle(ctx.path, ctx.body);
      if (signIn && (await isSignInLockedOut(signIn))) {
        throw APIError.from("TOO_MANY_REQUESTS", SIGN_IN_LOCKED_ERROR);
      }

      // The admin plugin validates role names and authorizes from `AUTH_ROLES`,
      // which is loaded here so a custom role is never "non-existent".
      await loadRoleDefinitions();

      // The instance's minimum sits above better-auth's own, so a password is
      // measured against it before the endpoint writes it.
      const passwordField = PASSWORD_FIELD_BY_PATH[ctx.path];
      if (passwordField) {
        const password = (ctx.body as Record<string, unknown> | undefined)?.[passwordField];
        if (typeof password === "string") {
          const problem = accountPolicyProblem(password, await getAccountPolicy());
          if (problem) {
            throw APIError.from("BAD_REQUEST", { code: "PASSWORD_TOO_SHORT", message: problem });
          }
        }
      }

      // Usernames are the login handle, so a credential account created without
      // one could not be signed into. both entry points must carry it.
      // Format and uniqueness are enforced by the username plugin itself.
      const createdByAdmin = ctx.path === ADMIN_CREATE_USER_PATH;
      if (ctx.path !== "/sign-up/email" && !createdByAdmin) return;

      const body = ctx.body as { username?: unknown; data?: { username?: unknown } } | undefined;
      const handle = createdByAdmin ? body?.data?.username : body?.username;
      if (typeof handle !== "string" || normalizeUsername(handle).length === 0) {
        throw APIError.from("BAD_REQUEST", USERNAME_REQUIRED_ERROR);
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      await recordRefusedSignIn(ctx.path, ctx.body, ctx.context.returned);
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (_user, context) => {
          // Applied here rather than in a middleware so it covers every path
          // that creates a user, whether or not a form was involved.
          await assertSignupsAllowed(context);
        },
        after: async (user) => {
          const count = await prisma.user.count();
          if (count <= 1) {
            await prisma.user.update({
              where: { id: user.id },
              data: { role: "admin" },
            });
          }
        },
      },
      update: {
        // Sign out every device that never passed the 2FA challenge when the
        // user enables two-factor; the enabling browser is re-issued a session
        // by the plugin immediately afterwards.
        after: async (user, context) => {
          await revokeSessionsOnTwoFactorEnable(user, context);
        },
      },
      delete: {
        // The user's directory and container are outside the database, so the
        // cascade does not reach them.
        after: async (user) => {
          await destroyUserSandbox(user.id);
        },
      },
    },
    account: {
      create: {
        // A Telegram login is also a link: the account row is the first moment
        // the Saale user and the Telegram identity belong together, and the
        // bot routes messages by that link, not by the session.
        after: async (account) => {
          await linkTelegramFromOidcLogin(account);
        },
      },
    },
  },
  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      ac: saaleAccessControl,
      roles: AUTH_ROLES,
    }),
    twoFactor({
      issuer: "Saale",
    }),
    username({
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: isValidUsername,
      usernameNormalization: normalizeUsername,
      // Validate the stored handle rather than the raw input: normalization
      // trims and lowercases, so `Ada.Lovelace` and ` ada.lovelace ` collide.
      validationOrder: { username: "post-normalization" },
      // `name` already carries the handle as typed; no second display field.
      displayUsername: false,
    }),
    // Absent (no provider, no login) unless the instance has OIDC credentials.
    ...telegramOidcPlugins(),
  ],
});
