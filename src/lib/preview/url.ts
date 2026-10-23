/**
 * Preview hostnames: what one is, and what a deployment has to put in front of
 * the proxy to serve them.
 */

import { isSandboxIdentity } from "@/lib/sandbox/identity";
import { previewConfig } from "./config";
import { PREVIEW_TOKEN_LENGTH, previewToken } from "./token";

export { previewConfig, previewsEnabled, previewFrameSource } from "./config";

const LABEL_PATTERN = /^(.+)-(\d{1,5})-([0-9a-f]+)$/;

/** The hostname for one port of one workspace. */
export function previewHost(identity: string, port: number): string {
  const { domain } = previewConfig();
  if (!domain) throw new Error("PREVIEW_DOMAIN is not set, so previews are off");

  const key = process.env.SANDBOX_API_KEY?.trim();
  if (!key) throw new Error("SANDBOX_API_KEY is not set, so preview URLs cannot be signed");

  const label = `${identity.toLowerCase()}-${port}-${previewToken({ identity, port }, key)}`;
  if (label.length > 63) throw new Error(`Preview hostname label too long: ${label}`);

  return `${label}.${domain}`;
}

/** The host port the proxy listens on, published by compose. */
export const PREVIEW_PROXY_PORT = 8101;

/** Shown in the block when this deployment has no domain yet. */
export const PREVIEW_PLACEHOLDER_DOMAIN = "preview.example.com";

/** What an operator has to put in front of the proxy, filled in and ready to paste. */
export interface PreviewSetup {
  /** The real domain, or a placeholder to show while previews are off. */
  domain: string;
  /** The nginx vhost for the wildcard host. */
  nginx: string;
  /** Hits the proxy at the wildcard host, so the answer proves DNS, TLS and nginx. */
  probeUrl: string | null;
}

export function previewSetup(): PreviewSetup {
  const { domain: configured, scheme } = previewConfig();
  const domain = configured ?? PREVIEW_PLACEHOLDER_DOMAIN;

  return {
    domain,
    probeUrl: configured ? `${scheme}://probe.${configured}/__preview/health` : null,
    nginx: `server {
    listen 443 ssl http2;
    server_name *.${domain};
    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:${PREVIEW_PROXY_PORT};
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}`,
  };
}

/** The full URL for one port of one workspace. */
export function previewUrl(identity: string, port: number): string {
  const { scheme } = previewConfig();
  return `${scheme}://${previewHost(identity, port)}`;
}

/** A parsed preview hostname. */
export interface ParsedPreviewHost {
  identity: string;
  port: number;
  token: string;
}

/**
 * The identity, port and token a hostname carries, or null.
 *
 * The label is read right to left: the token is fixed length hex, the port is
 * the number before it, and everything left is the identity.
 */
export function parsePreviewHost(hostname: string): ParsedPreviewHost | null {
  const host = hostname.trim().replace(/:\d+$/, "").replace(/\.+$/, "").toLowerCase();
  const label = host.split(".")[0];
  if (!label || label.length > 63) return null;

  const match = LABEL_PATTERN.exec(label);
  if (!match) return null;

  const [, identity, portText, token] = match;
  const port = Number(portText);
  if (!identity || !token || !isSandboxIdentity(identity)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (token.length !== PREVIEW_TOKEN_LENGTH) return null;

  return { identity, port, token };
}
