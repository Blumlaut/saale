/**
 * Sandbox settings, read from the environment.
 *
 * A function rather than module constants so a test (or a long-lived process
 * that has its env replaced) sees the current values. Defaults are the values a
 * single-host compose deployment runs with, so only the secrets have to be set.
 */

import path from "node:path";

export interface SandboxConfig {
  /** `http://sandbox-exec:8100` in the app. Unset means no commands. */
  url: string | undefined;
  /** Bearer key for the service. */
  apiKey: string | undefined;
  /** Volume mount point. The same path in the app and in a tenant container. */
  workspacesDir: string;
  /** Docker volume holding the workspaces. */
  volume: string;
  /** Tenant image, built from `Dockerfile.sandbox`. */
  image: string;
  /** Network a tenant container joins: internet, nothing else in the project. */
  network: string;
  /** Account commands run as: `root` (installs work) or `agent` (tighter). */
  user: string;
  /** Owner of files the app writes into the volume. */
  uid: number;
  gid: number;
  memory: string;
  pids: number;
  cpus: number;
  /** Idle minutes before a container is stopped. */
  idleMinutes: number;
  /** Age in days before a container is removed. */
  ttlDays: number;
  /** Age in hours before a scratch file in a workspace is removed. */
  tmpHours: number;
  /** Port the service listens on. */
  port: number;
  /** Port preview hostnames are served on. 0 turns previews off. */
  previewPort: number;
}

const DEFAULTS = {
  workspacesDir: "/workspaces",
  volume: "saale_workspaces",
  image: "saale-sandbox",
  network: "saale-sandbox",
  user: "root",
  uid: 1000,
  gid: 1000,
  memory: "4g",
  pids: 512,
  cpus: 2,
  idleMinutes: 240,
  ttlDays: 7,
  tmpHours: 72,
  port: 8100,
  previewPort: 8101,
} as const;

function text(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name}="${raw}" is not a non-negative number, using ${fallback}`);
    return fallback;
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function sandboxConfig(): SandboxConfig {
  return {
    url: optional("SANDBOX_URL"),
    apiKey: optional("SANDBOX_API_KEY"),
    workspacesDir: path.resolve(text("SANDBOX_WORKSPACES_DIR", DEFAULTS.workspacesDir)),
    volume: text("SANDBOX_VOLUME", DEFAULTS.volume),
    image: text("SANDBOX_CONTAINER_IMAGE", DEFAULTS.image),
    network: text("SANDBOX_NETWORK", DEFAULTS.network),
    user: text("SANDBOX_USER", DEFAULTS.user),
    uid: integer("SANDBOX_UID", DEFAULTS.uid),
    gid: integer("SANDBOX_GID", DEFAULTS.gid),
    memory: text("SANDBOX_MEMORY", DEFAULTS.memory),
    pids: integer("SANDBOX_PIDS", DEFAULTS.pids),
    cpus: integer("SANDBOX_CPUS", DEFAULTS.cpus),
    idleMinutes: integer("SANDBOX_IDLE_MINUTES", DEFAULTS.idleMinutes),
    ttlDays: integer("SANDBOX_CONTAINER_TTL_DAYS", DEFAULTS.ttlDays),
    tmpHours: integer("SANDBOX_TMP_HOURS", DEFAULTS.tmpHours),
    port: integer("SANDBOX_EXEC_PORT", DEFAULTS.port),
    previewPort: integer("SANDBOX_PREVIEW_PORT", DEFAULTS.previewPort),
  };
}
