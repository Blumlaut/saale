/**
 * Preview hostnames: what one is, and what a deployment has to put in front of
 * the proxy to serve them.
 */

import { createHash } from "node:crypto";
import { previewConfig } from "./config";
import { PREVIEW_TOKEN_LENGTH, previewToken } from "./token";

export { previewConfig, previewsEnabled } from "./config";

/** Hex characters standing in for an identity, so the label fits a DNS name. */
export const PREVIEW_SLUG_LENGTH = 10;

/** `<slug>-<port>-<token>`, at most 33 characters, whatever the user id is. */
const LABEL_PATTERN = new RegExp(
  `^([0-9a-f]{${PREVIEW_SLUG_LENGTH}})-(\\d{1,5})-([0-9a-f]{${PREVIEW_TOKEN_LENGTH}})$`,
);

/**
 * The short name a preview hostname carries for a workspace.
 *
 * A hash keeps the label to a fixed width whatever the identity is, and leaves
 * the workspace behind it out of a URL that gets pasted around; the proxy maps
 * the slug back to the container it already knows.
 */
export function previewIdentitySlug(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, PREVIEW_SLUG_LENGTH);
}

/** The hostname for one port of one workspace. */
export function previewHost(identity: string, port: number): string {
  const { domain } = previewConfig();
  if (!domain) throw new Error("PREVIEW_DOMAIN is not set, so previews are off");

  const key = process.env.SANDBOX_API_KEY?.trim();
  if (!key) throw new Error("SANDBOX_API_KEY is not set, so preview URLs cannot be signed");

  const slug = previewIdentitySlug(identity);
  return `${slug}-${port}-${previewToken({ identity, port }, key)}.${domain}`;
}

/** The full URL for one port of one workspace. */
export function previewUrl(identity: string, port: number): string {
  const { scheme } = previewConfig();
  return `${scheme}://${previewHost(identity, port)}`;
}

/** A parsed preview hostname. */
export interface ParsedPreviewHost {
  slug: string;
  port: number;
  token: string;
}

/**
 * The workspace slug, port and token a hostname carries, or null.
 *
 * The label is read right to left: the token and the slug are fixed length hex,
 * and the port is the number between them.
 */
export function parsePreviewHost(hostname: string): ParsedPreviewHost | null {
  const host = hostname.trim().replace(/:\d+$/, "").replace(/\.+$/, "").toLowerCase();
  const label = host.split(".")[0];
  if (!label || label.length > 63) return null;

  const match = LABEL_PATTERN.exec(label);
  if (!match) return null;

  const [, slug, portText, token] = match;
  const port = Number(portText);
  if (!slug || !token) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { slug, port, token };
}
