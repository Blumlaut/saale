// Must be imported before betterAuth() is constructed: Next dev can evaluate
// this module before .env is loaded, in which case better-auth would fall
// back to its hardcoded default secret and cookies would be signed with a
// different secret than other module instances — intermittently invalidating
// sessions.
import "dotenv/config";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { username } from "better-auth/plugins/username";
import { prisma } from "@/lib/db";
import { revokeSessionsOnTwoFactorEnable } from "@/lib/auth/two-factor";
import { ADMIN_CREATE_USER_PATH, assertSignupsAllowed } from "@/lib/auth/signups";
import { linkTelegramFromOidcLogin, telegramOidcPlugins } from "@/lib/telegram/oidc";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REQUIRED_ERROR,
  isValidUsername,
  normalizeUsername,
} from "@/lib/auth/username";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_REFRESH_WINDOW_SECONDS,
  sessionCookieAttributes,
} from "@/lib/auth/session-config";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  socialProviders: {},
  // Security settings
  advanced: {
    defaultCookieAttributes: sessionCookieAttributes(),
  },
  // Session settings — one year, sliding: activity older than the refresh
  // window resets the expiry to the full TTL (see session-config.ts).
  session: {
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_REFRESH_WINDOW_SECONDS,
  },
  hooks: {
    // Usernames are the login handle, so a credential account created without
    // one could not be signed into — both entry points must carry it.
    // Format and uniqueness are enforced by the username plugin itself.
    before: createAuthMiddleware(async (ctx) => {
      const createdByAdmin = ctx.path === ADMIN_CREATE_USER_PATH;
      if (ctx.path !== "/sign-up/email" && !createdByAdmin) return;

      const body = ctx.body as { username?: unknown; data?: { username?: unknown } } | undefined;
      const handle = createdByAdmin ? body?.data?.username : body?.username;
      if (typeof handle !== "string" || normalizeUsername(handle).length === 0) {
        throw APIError.from("BAD_REQUEST", USERNAME_REQUIRED_ERROR);
      }
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
