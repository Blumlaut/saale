/**
 * The signature in a preview hostname.
 *
 * A preview URL is a capability: whoever holds it can reach one port of one
 * workspace for as long as that port is listening. The signature is an HMAC
 * over the identity and the port, keyed by the sandbox key both sides already
 * share, so the proxy can check a URL without asking the app and nothing has to
 * be stored.
 *
 * 8 bytes, sixteen hex characters: the whole label has to stay well inside the
 * 63 characters a DNS label allows, and a capability that is unguessable at
 * that width is all a dev server's URL needs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Hex characters in a token. */
export const PREVIEW_TOKEN_LENGTH = 16;

const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${PREVIEW_TOKEN_LENGTH}}$`);

/** What one preview URL is bound to. */
export interface PreviewScope {
  identity: string;
  port: number;
}

function signature(scope: PreviewScope, key: string): string {
  return createHmac("sha256", key)
    .update(`saale:preview:${scope.identity}:${scope.port}`)
    .digest("hex")
    .slice(0, PREVIEW_TOKEN_LENGTH);
}

/** The token for one port of one workspace. Stable, so a URL survives a reload. */
export function previewToken(scope: PreviewScope, key: string): string {
  if (!key) throw new Error("A preview token needs the sandbox key");
  if (!Number.isInteger(scope.port) || scope.port < 1 || scope.port > 65535) {
    throw new Error(`Not a port: ${scope.port}`);
  }
  return signature(scope, key);
}

/** Whether `token` was issued for this scope. */
export function verifyPreviewToken(token: string, scope: PreviewScope, key: string): boolean {
  if (!key || !TOKEN_PATTERN.test(token)) return false;
  const expected = Buffer.from(signature(scope, key), "utf8");
  const given = Buffer.from(token, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
