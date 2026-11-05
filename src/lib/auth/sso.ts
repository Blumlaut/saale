/**
 * Company single sign-on over OpenID Connect.
 *
 * An instance can hold several providers, because a company can have more than
 * one directory (employees on Entra, contractors on Google). Each row in
 * `instance_sso` is one provider: its issuer, the client credentials registered
 * there, the domains a new account may come from, and a slug that names its
 * callback, `/api/auth/callback/sso-<slug>`.
 *
 * Accounts are created on first sign-in only for an address whose domain is on
 * that provider's list; with no list, sign-in is for accounts that already
 * exist. Either way the company's own directory decides who exists.
 */

import { randomBytes } from "node:crypto";
import { cache } from "react";
import { genericOAuth } from "better-auth/plugins";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { SSO_PROVIDER_ID_PREFIX, ssoProviderId } from "@/lib/auth/sso-login";
import {
  SSO_DEFAULT_NAME,
  SSO_DEFAULT_SCOPES,
  type SsoLoginProvider,
  type SsoProviderStatus,
} from "@/lib/auth/sso-config";
import { getPublicUrl } from "@/lib/public-url";

const WELL_KNOWN_SUFFIX = "/.well-known/openid-configuration";
/** 6 bytes make 12 hex characters, short enough to read in a callback URL. */
const SLUG_BYTES = 6;

/** The path an identity provider sends the browser back to, as the hooks see it. */
export const SSO_CALLBACK_PREFIX = `/callback/${SSO_PROVIDER_ID_PREFIX}`;

/** Whether a path is one of the providers' callbacks. */
export function isSsoCallbackPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(SSO_CALLBACK_PREFIX);
}

/** The provider a callback path belongs to, or null when it is not one. */
export function providerIdFromCallbackPath(path: string | null | undefined): string | null {
  if (!path || !isSsoCallbackPath(path)) return null;
  return path.slice("/callback/".length);
}

export interface SsoOidcConfig {
  /** better-auth's provider id, `sso-<slug>`. */
  providerId: string;
  /** The issuer's discovery document. */
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  /** The sign-in button's label. */
  name: string;
  scopes: string[];
  /** Lowercase domains a new account may come from. Empty means no new accounts. */
  allowedDomains: string[];
}

/** The discovery document for an issuer, or the URL itself when it already is one. */
export function discoveryUrlFor(issuer: string): string {
  const trimmed = issuer.trim().replace(/\/+$/, "");
  return trimmed.endsWith(WELL_KNOWN_SUFFIX) ? trimmed : `${trimmed}${WELL_KNOWN_SUFFIX}`;
}

/** A pasted host is an https issuer; anything already carrying a scheme is left alone. */
export function normalizeIssuer(issuer: string): string {
  const trimmed = issuer.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** `@` and case are how people type a domain; neither belongs in the list. */
export function normalizeDomains(domains: readonly string[]): string[] {
  const cleaned = domains.map((domain) => domain.trim().toLowerCase().replace(/^@/, ""));
  return [...new Set(cleaned.filter(Boolean))];
}

/** `openid` is what makes it OpenID Connect, so it is asked for either way. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const named = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const base = named.length > 0 ? named : [...SSO_DEFAULT_SCOPES];
  return base.includes("openid") ? base : ["openid", ...base];
}

/** The address's domain, lowercased, or null when it is not an address. */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() || null
  );
}

/** What to register at an identity provider as the redirect URI. */
export function buildSsoRedirectUri(providerId: string): string {
  return `${getPublicUrl()}/api/auth/callback/${providerId}`;
}

interface SsoRow {
  id: string;
  slug: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  encryptedClientSecret: string | null;
  name: string;
  scopes: string[];
  allowedDomains: string[];
  updatedAt: Date;
  updatedByUserId: string | null;
}

function readRows() {
  return prisma.instanceSso.findMany({ orderBy: { createdAt: "asc" } });
}

/**
 * One read of the provider list per request.
 *
 * Next gives every route its own copy of this module, so a cache with a clock
 * would let a save sit unseen in the bundle that serves sign-in. The version
 * below is what survives between requests.
 */
const readRowsOnce = cache(readRows);

/**
 * One stored provider as the auth instance needs it, or null when it cannot be
 * used.
 *
 * A secret that will not decrypt is logged and treated as missing: the login
 * page then offers no button rather than a redirect that cannot complete.
 */
function configOf(row: SsoRow): SsoOidcConfig | null {
  if (!row.enabled) return null;

  const issuer = row.issuer.trim();
  const clientId = row.clientId.trim();
  if (!issuer || !clientId || !row.encryptedClientSecret) return null;

  let clientSecret: string;
  try {
    clientSecret = decrypt(row.encryptedClientSecret);
  } catch (err) {
    console.error(`Failed to decrypt the single sign-on secret for "${row.slug}":`, err);
    return null;
  }

  return {
    providerId: ssoProviderId(row.slug),
    discoveryUrl: discoveryUrlFor(issuer),
    clientId,
    clientSecret,
    name: row.name.trim() || SSO_DEFAULT_NAME,
    scopes: normalizeScopes(row.scopes),
    allowedDomains: normalizeDomains(row.allowedDomains),
  };
}

export interface SsoConfigSnapshot {
  /** The providers the auth instance registers. */
  providers: SsoOidcConfig[];
  /** Bumped when the stored list changes, so the auth instance rebuilds. */
  version: number;
}

let cached: (SsoConfigSnapshot & { fingerprint: string }) | null = null;
let versionCounter = 0;

/**
 * The providers the auth instance is built from.
 *
 * A changed list gets a new version, which is what rebuilds the auth instance
 * and registers the providers.
 */
export async function loadSsoConfig(): Promise<SsoConfigSnapshot> {
  let providers: SsoOidcConfig[] = [];
  try {
    providers = (await readRowsOnce()).map(configOf).filter((config) => config !== null);
  } catch (err) {
    // A failed read must not take sign-in down with it; the instance keeps
    // signing people in with a password.
    console.error("Failed to read the single sign-on settings:", err);
  }

  const fingerprint = JSON.stringify(providers);
  if (cached?.fingerprint === fingerprint) return cached;

  cached = { providers, version: ++versionCounter, fingerprint };
  return cached;
}

/** Forget the cached list, so the next read sees a save. */
export function invalidateSsoConfig(): void {
  cached = null;
}

/** Whether an address may create an account through this provider. */
export async function isSsoEmailAllowed(email: string, providerId: string): Promise<boolean> {
  const { providers } = await loadSsoConfig();
  const config = providers.find((provider) => provider.providerId === providerId);
  if (!config) return false;

  const domain = emailDomain(email);
  return domain !== null && config.allowedDomains.includes(domain);
}

/**
 * The providers, registered only when the instance has credentials.
 *
 * A company IdP is trusted to own its addresses, so an existing account whose
 * email the provider reports is linked rather than refused (`auth.ts` lists
 * every provider as trusted). Identity is the provider's `sub`, which is why an
 * id_token has to verify before a provider is registered at all.
 */
export function ssoOidcPlugins(providers: SsoOidcConfig[]) {
  if (providers.length === 0) return [];

  return [
    genericOAuth({
      config: providers.map((provider) => ({
        providerId: provider.providerId,
        name: provider.name,
        discoveryUrl: provider.discoveryUrl,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        scopes: provider.scopes,
        requireIdTokenVerification: true,
        // With no domain list, signing in proves an account exists; it does
        // not create one. The list is what opens the door to new accounts.
        disableImplicitSignUp: provider.allowedDomains.length === 0,
      })),
    }),
  ];
}

/** Whether an existing account may be linked to these providers on first sign-in. */
export function ssoTrustedProviders(providers: SsoOidcConfig[]): string[] {
  return providers.map((provider) => provider.providerId);
}

function statusOf(row: SsoRow): SsoProviderStatus {
  const providerId = ssoProviderId(row.slug);
  const issuer = row.issuer.trim();
  const clientId = row.clientId.trim();
  const hasClientSecret = Boolean(row.encryptedClientSecret);

  return {
    id: row.id,
    providerId,
    name: row.name.trim() || SSO_DEFAULT_NAME,
    enabled: row.enabled,
    issuer: row.issuer,
    clientId: row.clientId,
    scopes: normalizeScopes(row.scopes),
    allowedDomains: normalizeDomains(row.allowedDomains),
    configured: row.enabled && issuer.length > 0 && clientId.length > 0 && hasClientSecret,
    hasClientSecret,
    discoveryUrl: issuer ? discoveryUrlFor(issuer) : null,
    redirectUri: buildSsoRedirectUri(providerId),
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}

/** Every provider the admin panel lists, configured or not. */
export async function listSsoProviders(): Promise<SsoProviderStatus[]> {
  return (await readRows()).map(statusOf);
}

/** The providers the login page offers a button for. */
export async function getSsoLoginProviders(): Promise<SsoLoginProvider[]> {
  const rows = await readRows();
  return rows.flatMap((row) => {
    const status = statusOf(row);
    return status.configured ? [{ id: status.providerId, name: status.name }] : [];
  });
}

export const ssoProviderPatchSchema = z.object({
  name: z.string().trim().min(1, "Give the provider a name").max(120).optional(),
  enabled: z.boolean().optional(),
  issuer: z.string().trim().max(2048).optional(),
  clientId: z.string().trim().max(512).optional(),
  scopes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  allowedDomains: z.array(z.string().trim().max(255)).max(200).optional(),
  /** A new secret. `null` forgets the stored one, absent leaves it alone. */
  clientSecret: z.string().max(4096).nullable().optional(),
});

export type SsoProviderPatch = z.infer<typeof ssoProviderPatchSchema>;

/** A new provider needs a name; everything else can be filled in later. */
export const ssoProviderCreateSchema = ssoProviderPatchSchema.extend({
  name: z.string().trim().min(1, "Give the provider a name").max(120),
});

export type SsoProviderCreate = z.infer<typeof ssoProviderCreateSchema>;

/** Why an issuer cannot be used, or null when it can. */
function issuerProblem(issuer: string): string | null {
  if (!issuer) return null;

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return "The issuer has to be an address, such as https://login.example.com";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The issuer has to be an http or https address";
  }
  return null;
}

/** The slug is what the callback URL carries, so it is short, lowercase and random. */
function newSlug(): string {
  return randomBytes(SLUG_BYTES).toString("hex");
}

/** Add a provider. Its callback URL only exists once it is stored. */
export async function createSsoProvider(
  patch: SsoProviderCreate,
  updatedByUserId: string,
): Promise<SsoProviderStatus> {
  const issuer = normalizeIssuer(patch.issuer ?? "");
  const problem = issuerProblem(issuer);
  if (problem) throw new Error(problem);

  const created = await prisma.instanceSso.create({
    data: {
      slug: newSlug(),
      name: patch.name.trim(),
      enabled: patch.enabled ?? true,
      issuer,
      clientId: (patch.clientId ?? "").trim(),
      scopes: normalizeScopes(patch.scopes ?? []),
      allowedDomains: normalizeDomains(patch.allowedDomains ?? []),
      encryptedClientSecret: patch.clientSecret ? encrypt(patch.clientSecret) : null,
      updatedByUserId,
    },
  });

  invalidateSsoConfig();
  return statusOf(created);
}

/** Save a patch over one stored provider, or null when it is gone. */
export async function updateSsoProvider(
  id: string,
  patch: SsoProviderPatch,
  updatedByUserId: string,
): Promise<SsoProviderStatus | null> {
  const row = await prisma.instanceSso.findUnique({ where: { id } });
  if (!row) return null;

  const issuer = normalizeIssuer(patch.issuer ?? row.issuer);
  const problem = issuerProblem(issuer);
  if (problem) throw new Error(problem);

  const updated = await prisma.instanceSso.update({
    where: { id },
    data: {
      name: (patch.name ?? row.name).trim(),
      enabled: patch.enabled ?? row.enabled,
      issuer,
      clientId: (patch.clientId ?? row.clientId).trim(),
      scopes: normalizeScopes(patch.scopes ?? row.scopes),
      allowedDomains: normalizeDomains(patch.allowedDomains ?? row.allowedDomains),
      encryptedClientSecret:
        patch.clientSecret === undefined
          ? row.encryptedClientSecret
          : patch.clientSecret === null
            ? null
            : encrypt(patch.clientSecret),
      updatedByUserId,
    },
  });

  invalidateSsoConfig();
  return statusOf(updated);
}

/** Forget one provider, secret and all. */
export async function removeSsoProvider(id: string): Promise<void> {
  await prisma.instanceSso.deleteMany({ where: { id } });
  invalidateSsoConfig();
}
