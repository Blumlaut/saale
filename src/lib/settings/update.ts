/**
 * Read and write Saale settings through the property registry.
 *
 * This module is the only writer of `AppSettings` and `AdminSettings`: both the
 * agent's settings tools and the settings API routes go through it, so a
 * setting cannot be stored without passing the registry's validation, and a
 * setting that feeds a pooled agent session is never written without the
 * session being rebuilt.
 *
 * Scope is re-checked here, not only in the tool: an admin property is refused
 * for a caller whose role holds no admin access, whatever path reached this
 * function.
 */

import { prisma } from "@/lib/db";
import { Prisma, type AdminSettings, type AppSettings } from "@prisma/client";
import { evictUserSessions } from "@/lib/pi/agent-pool";
import { isAdminUser } from "@/lib/permissions/check";
import { normalizeFeatureOverrides, type FeatureOverrides } from "@/lib/permissions/features";
import {
  ADMIN_PROPERTIES,
  coveredColumns,
  findProperty,
  propertiesForColumns,
  USER_PROPERTIES,
  type AdminProperty,
  type Property,
  type PropertyScope,
  type UserProperty,
} from "./properties";

/** A rejected settings change (unknown key, invalid value, wrong scope). */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** A property and its current value, as handed to the model. */
export interface PropertyView {
  key: string;
  /** Coarse bucket the property belongs to (`models`, `tools`, `admin`, …). */
  group: string;
  label: string;
  description: string;
  scope: PropertyScope;
  value: unknown;
  values?: readonly string[];
}

/** Optional filter for `listSettings`. */
export interface SettingsFilter {
  /** Key prefix (`models`, `tools.category.email`), matching a key or its parent path. */
  group?: string;
  /** An exact key. */
  key?: string;
}

// ─── Access ──────────────────────────────────────────────────────────────────

/** Whether the user is an admin. Read per call — a role can change. */
export { isAdminUser };

// ─── Rows ────────────────────────────────────────────────────────────────────

/** The user's settings row, created with defaults on first use. */
export async function ensureUserSettings(userId: string): Promise<AppSettings> {
  return prisma.appSettings.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

/** The global admin settings row, created with defaults on first use. */
export async function ensureAdminSettings(): Promise<AdminSettings> {
  return prisma.adminSettings.upsert({
    where: { id: "global" },
    create: { id: "global" },
    update: {},
  });
}

// ─── Views ───────────────────────────────────────────────────────────────────

function userView(property: UserProperty, row: AppSettings): PropertyView {
  return {
    key: property.key,
    group: property.group,
    label: property.label,
    description: property.description,
    scope: "user",
    value: property.read(row),
    ...(property.values ? { values: property.values } : {}),
  };
}

function adminView(property: AdminProperty, row: AdminSettings): PropertyView {
  return {
    key: property.key,
    group: property.group,
    label: property.label,
    description: property.description,
    scope: "admin",
    value: property.read(row),
    ...(property.values ? { values: property.values } : {}),
  };
}

/** Whether a property matches a filter (no filter matches everything). */
function matchesFilter(property: Property, filter: SettingsFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.key) return property.key === filter.key;
  if (filter.group) {
    return property.key === filter.group || property.key.startsWith(`${filter.group}.`);
  }
  return true;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every property the caller may see, with current values.
 *
 * Admin properties are included only for admins — a regular user must not even
 * discover the global settings.
 */
export async function listSettings(
  userId: string,
  filter?: SettingsFilter,
): Promise<PropertyView[]> {
  const results: PropertyView[] = [];

  const userRow = await ensureUserSettings(userId);
  for (const property of USER_PROPERTIES) {
    if (matchesFilter(property, filter)) results.push(userView(property, userRow));
  }

  if (await isAdminUser(userId)) {
    const adminRow = await ensureAdminSettings();
    for (const property of ADMIN_PROPERTIES) {
      if (matchesFilter(property, filter)) results.push(adminView(property, adminRow));
    }
  }

  return results;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate a value against its property (null means "restore the default"). */
function assertValid(property: Property, value: unknown): void {
  const result = property.schema.safeParse(value);
  if (result.success) return;
  const message = result.error.issues.map((issue) => issue.message).join("; ");
  throw new SettingsError(`Invalid value for "${property.key}": ${message}`);
}

/** Structural equality good enough for change detection (`true` = unchanged). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Writes: one property (the agent path) ───────────────────────────────────

/**
 * Set one property to a value (or back to its default, with `null`).
 *
 * @throws {SettingsError} When the key is unknown, the value is invalid, or an
 *   admin property is set by a non-admin.
 */
export async function setSetting(
  userId: string,
  key: string,
  value: unknown,
): Promise<PropertyView> {
  const property = findProperty(key);
  if (!property) {
    throw new SettingsError(`Unknown setting "${key}". Use settings_list to see the valid keys.`);
  }

  if (value !== null) assertValid(property, value);

  if (property.scope === "admin") {
    if (!(await isAdminUser(userId))) {
      throw new SettingsError(
        `"${key}" is an admin setting and can only be changed by an administrator.`,
      );
    }
    const row = await ensureAdminSettings();
    const updated = await prisma.adminSettings.update({
      where: { id: "global" },
      data: property.write(row, value),
    });
    // Global model settings feed the model runtime, so the acting admin's own
    // pooled sessions are rebuilt; other users pick the change up on rebuild.
    if (property.apply === "sessions") await evictUserSessions(userId);
    return adminView(property, updated);
  }

  const row = await ensureUserSettings(userId);
  const updated = await prisma.appSettings.update({
    where: { userId },
    data: property.write(row, value),
  });

  // A pooled agent session fixes its model, tools and system prompt when it is
  // built, so a change to any of those stays invisible until it is evicted.
  // In-flight sessions are skipped by the pool (disposing one aborts its run),
  // which includes the session the calling agent is running in.
  if (property.apply === "sessions") await evictUserSessions(userId);

  return userView(property, updated);
}

// ─── Writes: a column patch (the settings API path) ──────────────────────────

/** Keep only the patch entries that name a column some property owns. */
function pickCovered(
  scope: PropertyScope,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(coveredColumns(scope));
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.has(key)) picked[key] = value;
  }
  return picked;
}

/**
 * Apply a column-keyed patch — the shape the settings UI sends.
 *
 * Each touched column is traced back to the properties that own it: the
 * property's own `read` projects a value out of the patched row, the schema
 * validates it, and the property's `write` produces the canonical, sparse
 * column value. Properties that share a column (every tool category writes
 * `defaultToolConfig`) fold onto an evolving row so they cannot clobber each
 * other.
 *
 * @throws {SettingsError} When a value fails validation.
 */
export async function applyUserSettingsPatch(
  userId: string,
  patch: Record<string, unknown>,
): Promise<AppSettings> {
  const picked = pickCovered("user", patch);
  const current = await ensureUserSettings(userId);
  if (Object.keys(picked).length === 0) return current;

  const candidate = { ...current, ...picked } as AppSettings;
  const update: Record<string, unknown> = {};
  // Start from the patched row so each property's `write` normalizes the value
  // the client sent (and a layout keeps the order it was sent in), then fold
  // the canonical writes so properties sharing a column don't clobber each
  // other.
  const working = { ...candidate } as AppSettings;
  let evicts = false;

  for (const property of propertiesForColumns("user", Object.keys(picked))) {
    const leaf = property.read(candidate);
    if (leaf !== null && leaf !== undefined) assertValid(property, leaf);
    const written = property.write(working, leaf ?? null);
    Object.assign(update, written);
    Object.assign(working, written);
    if (property.apply === "sessions" && !sameValue(property.read(current), leaf)) evicts = true;
  }

  const settings = await prisma.appSettings.update({ where: { userId }, data: update });
  if (evicts) await evictUserSessions(userId);
  return settings;
}

/**
 * Apply a column-keyed patch to the global admin settings.
 *
 * @throws {SettingsError} When a value fails validation, or the caller is not
 *   an admin.
 */
export async function applyAdminSettingsPatch(
  actorUserId: string,
  patch: Record<string, unknown>,
): Promise<AdminSettings> {
  if (!(await isAdminUser(actorUserId))) {
    throw new SettingsError("Only an administrator can change global settings.");
  }

  const picked = pickCovered("admin", patch);
  const current = await ensureAdminSettings();
  if (Object.keys(picked).length === 0) return current;

  const candidate = { ...current, ...picked } as AdminSettings;
  const update: Record<string, unknown> = {};
  const working = { ...candidate } as AdminSettings;
  let evicts = false;

  for (const property of propertiesForColumns("admin", Object.keys(picked))) {
    const leaf = property.read(candidate);
    if (leaf !== null && leaf !== undefined) assertValid(property, leaf);
    const written = property.write(working, leaf ?? null);
    Object.assign(update, written);
    Object.assign(working, written);
    if (property.apply === "sessions" && !sameValue(property.read(current), leaf)) evicts = true;
  }

  const settings = await prisma.adminSettings.update({ where: { id: "global" }, data: update });
  if (evicts) await evictUserSessions(actorUserId);
  return settings;
}

// ─── Feature access (admin-set, internal column) ─────────────────────────────
//
// `AppSettings.features` is deliberately not a user property: it overrides
// feature gating, so exposing it to `applyUserSettingsPatch` would let a user
// switch on everything an admin turned off. Only the admin routes write it.

/** Persist an account's feature overrides and rebuild its pooled sessions. */
export async function setUserFeatures(userId: string, features: FeatureOverrides): Promise<void> {
  const wanted = normalizeFeatureOverrides(features);
  const current = await prisma.appSettings.findUnique({
    where: { userId },
    select: { features: true },
  });
  if (JSON.stringify(normalizeFeatureOverrides(current?.features)) === JSON.stringify(wanted)) {
    return;
  }

  const value = Object.keys(wanted).length ? (wanted as Prisma.InputJsonValue) : Prisma.DbNull;
  await prisma.appSettings.upsert({
    where: { userId },
    create: { userId, features: value },
    update: { features: value },
  });

  // Feature gating decides which tools a pooled session gets, so the account's
  // sessions have to be rebuilt for the change to reach the next turn.
  await evictUserSessions(userId);
}
