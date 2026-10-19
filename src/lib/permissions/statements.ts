/**
 * Saale permission statements — the single source of truth for what an account
 * may do.
 *
 * Two resources:
 * - `admin` — fine-grained admin capabilities (delegation between admins).
 * - `feature` — which product modules an account may use (feature gating for
 *   regular users). `admin` role grants every feature; `user` gets the
 *   instance's default feature set.
 *
 * Both are consumed by better-auth's access control (so its admin plugin
 * endpoints honour them) and by Saale's own `hasPermission` / `hasFeature`
 * helpers.
 */

import { createAccessControl } from "better-auth/plugins/access";

export const ADMIN_ACTIONS = [
  "access",
  "users",
  "models",
  "providers",
  "settings",
  "telegram",
] as const;

export const FEATURE_ACTIONS = [
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
] as const;

export const SAAL_STATEMENTS = {
  admin: [...ADMIN_ACTIONS],
  feature: [...FEATURE_ACTIONS],
} as const;

export const saaleAccessControl = createAccessControl(SAAL_STATEMENTS);

export type AdminAction = (typeof ADMIN_ACTIONS)[number];
export type FeatureAction = (typeof FEATURE_ACTIONS)[number];

/** Client-safe list of all feature keys. */
export const FEATURES = [...FEATURE_ACTIONS];
