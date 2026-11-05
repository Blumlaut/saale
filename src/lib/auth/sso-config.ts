/**
 * The instance's identity providers, as the admin panel and the login page
 * describe them.
 *
 * Client-safe: the settings page is a client component, so nothing here touches
 * the database or the provider plugin.
 */

export const SSO_DEFAULT_NAME = "Single sign-on";
export const SSO_DEFAULT_SCOPES = ["openid", "profile", "email"];

/** One provider's stored configuration, without the client secret. */
export interface SsoProviderSettings {
  /** The sign-in button's label. */
  name: string;
  /** The switch in the panel. Off means no button, whatever is stored. */
  enabled: boolean;
  /** The issuer URL, or its discovery document. */
  issuer: string;
  clientId: string;
  scopes: string[];
  /** Domains a new account may come from. Empty means existing accounts only. */
  allowedDomains: string[];
}

/** What the admin panel shows for one provider. */
export interface SsoProviderStatus extends SsoProviderSettings {
  /** The database id, used by the admin API. */
  id: string;
  /** better-auth's provider id, `sso-<slug>`. */
  providerId: string;
  /** Switched on, addressed, and holding a client secret. */
  configured: boolean;
  /** A secret is stored. The secret itself is never read out. */
  hasClientSecret: boolean;
  /** The issuer's discovery document, when an issuer is stored. */
  discoveryUrl: string | null;
  /** What to register at this provider. */
  redirectUri: string;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/** What the login page needs: a button per provider. */
export interface SsoLoginProvider {
  id: string;
  name: string;
}
