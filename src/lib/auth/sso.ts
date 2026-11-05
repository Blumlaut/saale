/**
 * Company single sign-on over OpenID Connect.
 *
 * One provider, configured in the admin panel: an instance belongs to one
 * company, and that company has one identity provider. The issuer names it, the
 * client credentials are the ones registered there, and the redirect URI to
 * register is this instance's `/api/auth/callback/sso-oidc`.
 *
 * Accounts are created on first sign-in only for an address whose domain is on
 * the allowed list; with no list, sign-in is for accounts that already exist.
 * Either way the company's own directory decides who exists.
 */

import { cache } from "react";
import { genericOAuth } from "better-auth/plugins";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { SSO_OIDC_PROVIDER_ID } from "@/lib/auth/sso-login";
import { SSO_DEFAULT_NAME, SSO_DEFAULT_SCOPES, type SsoStatus } from "@/lib/auth/sso-config";
import { getPublicUrl } from "@/lib/public-url";

/** Where the IdP sends the browser back to, as the auth hooks see the path. */
export const SSO_CALLBACK_PATH = `/callback/${SSO_OIDC_PROVIDER_ID}`;

const WELL_KNOWN_SUFFIX = "/.well-known/openid-configuration";

export interface SsoOidcConfig {
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

/** What to register at the identity provider as the redirect URI. */
export function buildSsoRedirectUri(): string {
  return `${getPublicUrl()}/api/auth/callback/${SSO_OIDC_PROVIDER_ID}`;
}

interface SsoRow {
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

function readRow() {
  return prisma.instanceSso.findUnique({ where: { id: "global" } });
}

/**
 * One row read per request.
 *
 * Next gives every route its own copy of this module, so a cache with a clock
 * would let a save sit unseen in the bundle that serves sign-in. The version
 * below is what survives between requests.
 */
const readRowOnce = cache(readRow);

/**
 * The provider this instance signs people in with, or null when it has none.
 *
 * A secret that will not decrypt is logged and treated as missing: the login
 * page then offers no button rather than a redirect that cannot complete.
 */
function configOf(row: SsoRow | null): SsoOidcConfig | null {
  if (!row || !row.enabled) return null;

  const issuer = row.issuer.trim();
  const clientId = row.clientId.trim();
  if (!issuer || !clientId || !row.encryptedClientSecret) return null;

  let clientSecret: string;
  try {
    clientSecret = decrypt(row.encryptedClientSecret);
  } catch (err) {
    console.error("Failed to decrypt the instance single sign-on secret:", err);
    return null;
  }

  return {
    discoveryUrl: discoveryUrlFor(issuer),
    clientId,
    clientSecret,
    name: row.name.trim() || SSO_DEFAULT_NAME,
    scopes: normalizeScopes(row.scopes),
    allowedDomains: normalizeDomains(row.allowedDomains),
  };
}

export interface SsoConfigSnapshot {
  config: SsoOidcConfig | null;
  /** Bumped when the stored configuration changes, so the auth instance rebuilds. */
  version: number;
}

let cached: (SsoConfigSnapshot & { fingerprint: string }) | null = null;
let versionCounter = 0;

/**
 * The provider the auth instance is built from.
 *
 * A changed row gets a new version, which is what rebuilds the auth instance
 * and registers the provider.
 */
export async function loadSsoConfig(): Promise<SsoConfigSnapshot> {
  let config: SsoOidcConfig | null = null;
  try {
    config = configOf(await readRowOnce());
  } catch (err) {
    // A failed read must not take sign-in down with it; the instance keeps
    // signing people in with a password.
    console.error("Failed to read the instance single sign-on settings:", err);
  }

  const fingerprint = JSON.stringify(config);
  if (cached?.fingerprint === fingerprint) return cached;

  cached = { config, version: ++versionCounter, fingerprint };
  return cached;
}

/** Forget the cached configuration, so the next read sees a save. */
export function invalidateSsoConfig(): void {
  cached = null;
}

/** Whether an address may create an account through single sign-on. */
export async function isSsoEmailAllowed(email: string): Promise<boolean> {
  const { config } = await loadSsoConfig();
  if (!config) return false;

  const domain = emailDomain(email);
  return domain !== null && config.allowedDomains.includes(domain);
}

/**
 * The provider, registered only when the instance has credentials.
 *
 * A company IdP is trusted to own its addresses, so an existing account whose
 * email the provider reports is linked rather than refused (`auth.ts` lists this
 * provider as trusted). Identity is the provider's `sub`, which is why an
 * id_token has to verify before the provider is registered at all.
 */
export function ssoOidcPlugins(config: SsoOidcConfig | null) {
  if (!config) return [];

  return [
    genericOAuth({
      config: [
        {
          providerId: SSO_OIDC_PROVIDER_ID,
          name: config.name,
          discoveryUrl: config.discoveryUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          scopes: config.scopes,
          requireIdTokenVerification: true,
          // With no domain list, signing in proves an account exists; it does
          // not create one. The list is what opens the door to new accounts.
          disableImplicitSignUp: config.allowedDomains.length === 0,
        },
      ],
    }),
  ];
}

/** Whether an existing account may be linked to this provider on first sign-in. */
export function ssoTrustedProviders(config: SsoOidcConfig | null): string[] {
  return config ? [SSO_OIDC_PROVIDER_ID] : [];
}

export const instanceSsoPatchSchema = z.object({
  enabled: z.boolean().optional(),
  issuer: z.string().trim().max(2048).optional(),
  clientId: z.string().trim().max(512).optional(),
  name: z.string().trim().max(120).optional(),
  scopes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  allowedDomains: z.array(z.string().trim().max(255)).max(200).optional(),
  /** A new secret. `null` forgets the stored one, absent leaves it alone. */
  clientSecret: z.string().max(4096).nullable().optional(),
});

export type InstanceSsoPatch = z.infer<typeof instanceSsoPatchSchema>;

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

function statusOf(row: SsoRow | null): SsoStatus {
  const enabled = row?.enabled ?? true;
  const issuer = row?.issuer ?? "";
  const clientId = row?.clientId ?? "";
  const hasClientSecret = Boolean(row?.encryptedClientSecret);

  return {
    enabled,
    issuer,
    clientId,
    name: row?.name ?? "",
    scopes: normalizeScopes(row?.scopes ?? []),
    allowedDomains: normalizeDomains(row?.allowedDomains ?? []),
    configured: enabled && issuer.length > 0 && clientId.length > 0 && hasClientSecret,
    hasClientSecret,
    discoveryUrl: issuer ? discoveryUrlFor(issuer) : null,
    redirectUri: buildSsoRedirectUri(),
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  };
}

/** What the login page and the admin panel show about this instance's provider. */
export async function getSsoStatus(): Promise<SsoStatus> {
  return statusOf(await readRow());
}

/** Save a patch over the stored configuration. */
export async function saveInstanceSso(
  patch: InstanceSsoPatch,
  updatedByUserId: string,
): Promise<SsoStatus> {
  const row = await readRow();

  const issuer = normalizeIssuer(patch.issuer ?? row?.issuer ?? "");
  const problem = issuerProblem(issuer);
  if (problem) throw new Error(problem);

  const settings = {
    enabled: patch.enabled ?? row?.enabled ?? true,
    issuer,
    clientId: (patch.clientId ?? row?.clientId ?? "").trim(),
    name: (patch.name ?? row?.name ?? "").trim(),
    scopes: normalizeScopes(patch.scopes ?? row?.scopes ?? []),
    allowedDomains: normalizeDomains(patch.allowedDomains ?? row?.allowedDomains ?? []),
  };

  const secret =
    patch.clientSecret === undefined
      ? (row?.encryptedClientSecret ?? null)
      : patch.clientSecret === null
        ? null
        : encrypt(patch.clientSecret);

  await prisma.instanceSso.upsert({
    where: { id: "global" },
    create: { id: "global", ...settings, encryptedClientSecret: secret, updatedByUserId },
    update: { ...settings, encryptedClientSecret: secret, updatedByUserId },
  });

  invalidateSsoConfig();
  return getSsoStatus();
}

/** Forget the provider, secret and all. */
export async function clearInstanceSso(): Promise<void> {
  await prisma.instanceSso.deleteMany({ where: { id: "global" } });
  invalidateSsoConfig();
}
