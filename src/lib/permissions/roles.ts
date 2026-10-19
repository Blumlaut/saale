/**
 * Named role bundles. A user's `User.role` column holds one of these names
 * (better-auth splits on commas, so a user may hold several — keep it to one
 * for now). `admin` is the only role that counts as an admin for better-auth's
 * plugin endpoints; the others delegate slices of the admin surface.
 */

import { saaleAccessControl } from "./statements";

const { newRole } = saaleAccessControl;

const ALL_FEATURES = {
  feature: [
    "mail",
    "calendar",
    "tasks",
    "jobs",
    "council",
    "infra",
    "mcp",
    "watchers",
    "terminal",
    "telegram",
    "web",
    "memory",
    "chatSearch",
    "agentJobs",
  ],
} as const;

export const ROLE_NAMES = ["admin", "models-manager", "user-manager", "support", "user"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const SAAL_ROLES = {
  admin: newRole({
    admin: ["access", "users", "models", "providers", "settings", "telegram"],
    ...ALL_FEATURES,
  }),
  "models-manager": newRole({
    admin: ["access", "models", "providers", "settings"],
    ...ALL_FEATURES,
  }),
  "user-manager": newRole({
    admin: ["access", "users"],
    ...ALL_FEATURES,
  }),
  support: newRole({
    admin: ["access", "users", "settings"],
    ...ALL_FEATURES,
  }),
  user: newRole({
    admin: [],
    // features are resolved from the instance default + per-user override,
    // not from the role, for non-admin accounts.
    feature: [],
  }),
} as const;
