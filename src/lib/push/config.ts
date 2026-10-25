/**
 * Web Push configuration.
 *
 * VAPID identifies this server to the browsers' push services (Chrome's FCM,
 * Mozilla's autopush, Apple's web push): a subscription is bound to the public
 * key that created it, so the key pair is instance-wide configuration rather
 * than a per-user setting. Generate a pair with `npx web-push generate-vapid-keys`
 * and keep it stable — rotating the keys invalidates every subscription and
 * every user has to re-enable notifications.
 */
import { getPublicUrl } from "@/lib/public-url";

/**
 * Contact address the push service can use to reach the operator (VAPID
 * "sub"). A `mailto:` or `https:` URI. Derived from the instance URL so a
 * deployment needs no extra setting, and push still works on a local instance.
 */
function defaultSubject(): string {
  try {
    return `mailto:noreply@${new URL(getPublicUrl()).hostname}`;
  } catch {
    return "mailto:noreply@localhost";
  }
}

/** Whether an admin has set up a VAPID key pair on this instance. */
export function isPushConfigured(): boolean {
  return Boolean(
    (process.env.VAPID_PUBLIC_KEY ?? "").trim() && (process.env.VAPID_PRIVATE_KEY ?? "").trim(),
  );
}

/**
 * The key pair and subject for `web-push`, or null when the instance has no
 * keys. Callers must handle null: push is an optional feature, not a
 * requirement for the app to start.
 */
export function getVapidConfig(): {
  publicKey: string;
  privateKey: string;
  subject: string;
} | null {
  if (!isPushConfigured()) return null;

  return {
    publicKey: (process.env.VAPID_PUBLIC_KEY ?? "").trim(),
    privateKey: (process.env.VAPID_PRIVATE_KEY ?? "").trim(),
    subject: (process.env.VAPID_SUBJECT ?? "").trim() || defaultSubject(),
  };
}

/** The application server key a browser subscribes with, or null when unset. */
export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}
