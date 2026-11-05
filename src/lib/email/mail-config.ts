/**
 * The instance mail relay's shape, shared by the admin API and its form.
 *
 * Client-safe: the settings page is a client component and has to name the
 * security modes. Nothing here touches the database.
 */

export const MAIL_SECURITIES = ["tls", "starttls", "none"] as const;
export type MailSecurity = (typeof MAIL_SECURITIES)[number];

/** The stored configuration, without the password. */
export interface InstanceMailSettings {
  enabled: boolean;
  host: string;
  port: number;
  /** `tls` is implicit TLS (465), `starttls` upgrades a plain connection (587). */
  security: MailSecurity;
  username: string;
  fromAddress: string;
  /** Empty sends the instance's own name. */
  fromName: string;
}

/** What the admin panel shows. */
export interface InstanceMailStatus extends InstanceMailSettings {
  /** A relay is stored and switched on. Mail is only sent when this is true. */
  configured: boolean;
  /** A password is stored. The password itself is never read out. */
  hasPassword: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
}
