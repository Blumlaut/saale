// Must be imported before betterAuth() is constructed: Next dev can evaluate
// this module before .env is loaded, in which case better-auth would fall
// back to its hardcoded default secret and cookies would be signed with a
// different secret than other module instances — intermittently invalidating
// sessions.
import "dotenv/config";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { prisma } from "@/lib/db";
import { revokeSessionsOnTwoFactorEnable } from "@/lib/auth/two-factor";

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
    defaultCookieAttributes: {
      sameSite: "strict" as const,
      secure: process.env.NODE_ENV === "production",
    },
  },
  // Session settings
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh every day
  },
  databaseHooks: {
    user: {
      create: {
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
  },
  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    twoFactor({
      issuer: "Saale",
    }),
  ],
});
