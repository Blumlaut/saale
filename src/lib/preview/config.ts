/**
 * Where preview URLs live, and whether this deployment has them.
 *
 * A preview is served from a hostname of its own so the app inside it needs no
 * base path and no rewriting: `https://<slug>-<port>-<token>.preview.<apex>`
 * reaches port 5173 of that workspace. The apex comes from `BETTER_AUTH_URL`,
 * so a deployment that already serves Saale over HTTPS needs no new variable,
 * and `PREVIEW_DOMAIN` replaces it when the wildcard lives elsewhere.
 *
 * No `node:` imports here: the middleware reads this to allow the frame.
 */

import { getPublicUrl } from "@/lib/public-url";

/** The domain previews are served from, and how. */
export interface PreviewConfig {
  /** null when this deployment has no preview domain, so previews are off. */
  domain: string | null;
  scheme: "http" | "https";
}

/** A pasted URL, a trailing dot or a path all mean the same domain. */
function normalizeDomain(raw: string): string | null {
  const withoutScheme = raw.trim().replace(/^[a-z]+:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.split(":")[0]?.replace(/\.+$/, "").toLowerCase();
  return host ? host : null;
}

/** A host a wildcard certificate can cover: a name with a dot, never an address. */
function isCertificateHost(host: string): boolean {
  return host.includes(".") && !/^[\d.]+$/.test(host) && !host.endsWith(".localhost");
}

export function previewConfig(): PreviewConfig {
  const configured = process.env.PREVIEW_DOMAIN?.trim();
  if (configured) return { domain: normalizeDomain(configured), scheme: "https" };

  const publicUrl = getPublicUrl();
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch (err) {
    console.error(`BETTER_AUTH_URL="${publicUrl}" is not a URL, so previews are off:`, err);
    return { domain: null, scheme: "https" };
  }

  const host = parsed.hostname.toLowerCase();
  if (!isCertificateHost(host)) return { domain: null, scheme: "https" };

  return { domain: `preview.${host}`, scheme: parsed.protocol === "http:" ? "http" : "https" };
}

/** Whether this deployment can mint preview URLs at all. */
export function previewsEnabled(): boolean {
  return previewConfig().domain !== null;
}

/** The `frame-src` a page needs to embed a preview, and nothing else. */
export function previewFrameSource(): string {
  const { domain, scheme } = previewConfig();
  return domain ? `frame-src 'self' ${scheme}://*.${domain}` : "frame-src 'self'";
}
