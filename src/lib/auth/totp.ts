/**
 * Helpers shared by the TOTP setup UI (settings) and tests.
 * The server-side verification lives in better-auth's two-factor plugin.
 */

const BASE32_RE = /^[A-Z2-7]+$/;

/**
 * Extract the base32 secret from an `otpauth://` URI.
 * Returns null when the URI is malformed or carries no usable secret —
 * the UI must fall back to asking for a fresh URI instead of guessing.
 */
export function parseTotpSecret(totpUri: string): string | null {
  // `otpauth:` is a non-special URL scheme, so the type segment ("totp")
  // is not part of the pathname — parse the query string directly.
  if (typeof totpUri !== "string" || !totpUri.startsWith("otpauth://totp/")) return null;
  const queryIndex = totpUri.indexOf("?");
  if (queryIndex === -1) return null;
  const query = totpUri.slice(queryIndex + 1);
  const secret = new URLSearchParams(query).get("secret");
  if (!secret) return null;
  const normalized = secret.toUpperCase().replace(/\s+/g, "");
  return BASE32_RE.test(normalized) ? normalized : null;
}

/** True when the value looks like a 6-digit TOTP code (input gate only). */
export function isTotpCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}
