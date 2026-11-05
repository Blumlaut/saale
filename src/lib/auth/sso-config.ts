/**
 * The instance's identity provider, as the admin panel and the login page
 * describe it.
 *
 * Client-safe: the settings page is a client component, so nothing here touches
 * the database or the provider plugin.
 */

export const SSO_DEFAULT_NAME = "Single sign-on";
export const SSO_DEFAULT_SCOPES = ["openid", "profile", "email"];

/** The stored configuration, without the client secret. */
export interface SsoSettings {
  /** The switch in the panel. Off means no button, whatever is stored. */
  enabled: boolean;
  /** The issuer URL, or its discovery document. */
  issuer: string;
  clientId: string;
  /** The sign-in button's label. Empty shows the default. */
  name: string;
  scopes: string[];
  /** Domains a new account may come from. Empty means existing accounts only. */
  allowedDomains: string[];
}

/** What the admin panel and the login page show. */
export interface SsoStatus extends SsoSettings {
  /** Switched on, addressed, and holding a client secret. */
  configured: boolean;
  /** A secret is stored. The secret itself is never read out. */
  hasClientSecret: boolean;
  /** The issuer's discovery document, when an issuer is stored. */
  discoveryUrl: string | null;
  /** What to register at the identity provider. */
  redirectUri: string;
  updatedAt: string | null;
  updatedByUserId: string | null;
}
