/**
 * Company single sign-on over OpenID Connect.
 *
 * One provider, configured by the deployment: an instance belongs to one
 * company, and that company has one identity provider. `SSO_OIDC_ISSUER` names
 * it, the client credentials are the ones registered there, and the redirect
 * URI to register is this instance's `/api/auth/callback/sso-oidc`.
 *
 * Accounts are created on first sign-in only for an address whose domain is on
 * `SSO_ALLOWED_DOMAINS`; with no list, sign-in is for accounts that already
 * exist. Either way the company's own directory decides who exists.
 */

import { genericOAuth } from "better-auth/plugins";
import { SSO_OIDC_PROVIDER_ID } from "@/lib/auth/sso-login";
import { getPublicUrl } from "@/lib/public-url";

/** Where the IdP sends the browser back to, as the auth hooks see the path. */
export const SSO_CALLBACK_PATH = `/callback/${SSO_OIDC_PROVIDER_ID}`;

const DEFAULT_SSO_NAME = "Single sign-on";
const DEFAULT_SSO_SCOPES = ["openid", "profile", "email"];
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

/** `openid` is what makes it OpenID Connect, so it is asked for either way. */
function scopesFromEnv(): string[] {
  const named = (process.env.SSO_OIDC_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = named.length > 0 ? named : [...DEFAULT_SSO_SCOPES];
  return scopes.includes("openid") ? scopes : ["openid", ...scopes];
}

/** `@` and case are how people type a domain; neither belongs in the list. */
function allowedDomainsFromEnv(): string[] {
  return (process.env.SSO_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** The deployed configuration, or null when this instance has no identity provider. */
export function getSsoOidcConfig(): SsoOidcConfig | null {
  const issuer = (process.env.SSO_OIDC_ISSUER ?? "").trim();
  const clientId = (process.env.SSO_OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.SSO_OIDC_CLIENT_SECRET ?? "").trim();
  if (!issuer || !clientId || !clientSecret) return null;

  return {
    discoveryUrl: discoveryUrlFor(issuer),
    clientId,
    clientSecret,
    name: (process.env.SSO_OIDC_NAME ?? "").trim() || DEFAULT_SSO_NAME,
    scopes: scopesFromEnv(),
    allowedDomains: allowedDomainsFromEnv(),
  };
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

/** Whether an address may create an account through single sign-on. */
export function isSsoEmailAllowed(email: string): boolean {
  const config = getSsoOidcConfig();
  if (!config) return false;

  const domain = emailDomain(email);
  if (!domain) return false;
  return config.allowedDomains.includes(domain);
}

/** What to register at the identity provider as the redirect URI. */
export function buildSsoRedirectUri(): string {
  return `${getPublicUrl()}/api/auth/callback/${SSO_OIDC_PROVIDER_ID}`;
}

/**
 * The provider, registered only when the instance has credentials.
 *
 * A company IdP is trusted to own its addresses, so an existing account whose
 * email the provider reports is linked rather than refused (`auth.ts` lists this
 * provider as trusted). Identity is the provider's `sub`, which is why an
 * id_token has to verify before the provider is registered at all.
 */
export function ssoOidcPlugins() {
  const config = getSsoOidcConfig();
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
export function ssoTrustedProviders(): string[] {
  return getSsoOidcConfig() ? [SSO_OIDC_PROVIDER_ID] : [];
}

export interface SsoStatus {
  /** Credentials are present, so better-auth registers the provider at all. */
  enabled: boolean;
  /** The sign-in button's label. */
  name: string;
  /** The issuer's discovery document, when configured. */
  discoveryUrl: string | null;
  /** Domains a new account may come from. Empty means existing accounts only. */
  allowedDomains: string[];
  /** What to register at the identity provider. */
  redirectUri: string;
  /** The scopes a sign-in asks for. */
  scopes: string[];
}

/** What the login page and the admin panel show about this instance's provider. */
export function getSsoStatus(): SsoStatus {
  const config = getSsoOidcConfig();
  return {
    enabled: config !== null,
    name: config?.name ?? DEFAULT_SSO_NAME,
    discoveryUrl: config?.discoveryUrl ?? null,
    allowedDomains: config?.allowedDomains ?? [],
    redirectUri: buildSsoRedirectUri(),
    scopes: config?.scopes ?? [...DEFAULT_SSO_SCOPES],
  };
}
