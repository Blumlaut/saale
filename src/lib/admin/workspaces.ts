/**
 * The workspace audit: what each sandbox holds on disk, what it is running, and
 * which directories no account owns.
 *
 * Sizes come from the volume, which is mounted in the app. Containers come from
 * `sandbox-exec`, which holds the Docker socket.
 *
 * A measurement takes seconds, so the page reads the last one and asks for a
 * new one. One measurement runs at a time and its answer lives in memory.
 */

import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { getActiveSessions } from "@/lib/redis";
import * as sandboxClient from "@/lib/sandbox/client";
import { parseIdentity, userIdentity } from "@/lib/sandbox/identity";
import { destroySandbox } from "@/lib/sandbox/teardown";
import { listWorkspaceIdentities, measureWorkspaceUsage } from "@/lib/sandbox/usage";
import { workspacesDir } from "@/lib/sandbox/workspace";

/** Whose workspace a directory is. */
export type WorkspaceKind = "user" | "orphan";

/** What a directory on the volume holds and is doing. */
export interface WorkspaceAuditRow {
  identity: string;
  kind: WorkspaceKind;
  /** Null for a directory no account owns. */
  owner: { name: string; detail: string; image: string | null } | null;
  /** Bytes on disk, null while no measurement has seen this identity. */
  bytes: number | null;
  container: "running" | "stopped" | "absent" | "unknown";
  /** Conversations generating right now. */
  running: number;
}

export interface WorkspaceAudit {
  rows: WorkspaceAuditRow[];
  /** The filesystem holding the volume: total and free bytes, null if it would not answer. */
  volume: { total: number; free: number } | null;
  /** When the sizes were taken, null before any measurement has finished. */
  measuredAt: number | null;
  measuring: boolean;
  /** The last measurement's failure, or null. */
  error: string | null;
}

/** The last sizes and when they were taken. Each process measures for itself. */
let measured: { at: number; bytes: Map<string, number> } | null = null;
let running: Promise<void> | null = null;
let lastError: string | null = null;

/** Whether a measurement is running right now. */
export function isMeasuring(): boolean {
  return running !== null;
}

/**
 * Measure every workspace, unless one is already running.
 *
 * Callers may ignore the promise: the page keeps the previous numbers until the
 * new ones land.
 */
export function startMeasurement(): Promise<void> {
  if (running) return running;
  const dir = workspacesDir();
  running = (async () => {
    try {
      const identities = await listWorkspaceIdentities(dir);
      const usage = await measureWorkspaceUsage(dir, identities);
      measured = { at: Date.now(), bytes: new Map(usage.map((row) => [row.identity, row.bytes])) };
      lastError = null;
    } catch (err) {
      console.error("Failed to measure the workspaces volume:", err);
      lastError = err instanceof Error ? err.message : "Measurement failed";
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Bytes per identity as the last measurement left them, null when it never ran. */
export function lastMeasurement(): { at: number; bytes: Map<string, number> } | null {
  return measured;
}

/** Everything the audit page shows, from disk, database, Redis and the sandbox service. */
export async function getWorkspaceAudit(): Promise<WorkspaceAudit> {
  const dir = workspacesDir();
  const identities = await listWorkspaceIdentities(dir);
  const [owners, containers, volume] = await Promise.all([
    loadOwners(),
    loadContainers(),
    volumeSpace(dir),
  ]);

  const rows: WorkspaceAuditRow[] = identities.map((identity) => {
    const owner = owners.byIdentity.get(identity);
    return {
      identity,
      kind: owner ? "user" : "orphan",
      owner: owner ?? null,
      bytes: measured?.bytes.get(identity) ?? null,
      container:
        containers.byIdentity.get(identity) ?? (containers.available ? "absent" : "unknown"),
      running: owners.runCounts.get(identity) ?? 0,
    };
  });

  // Largest first, with never-measured rows on top.
  rows.sort((a, b) => (b.bytes ?? Number.MAX_SAFE_INTEGER) - (a.bytes ?? Number.MAX_SAFE_INTEGER));

  return {
    rows,
    volume,
    measuredAt: measured?.at ?? null,
    measuring: isMeasuring(),
    error: lastError,
  };
}

/** Who an identity belongs to. */
interface WorkspaceOwner {
  name: string;
  detail: string;
  image: string | null;
}

interface LoadedOwners {
  byIdentity: Map<string, WorkspaceOwner>;
  /** Generations running right now, keyed by identity. */
  runCounts: Map<string, number>;
}

/** Owners from the database, and how much of their work is live. */
async function loadOwners(): Promise<LoadedOwners> {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, image: true },
  });

  const byIdentity = new Map<string, WorkspaceOwner>();
  const runCounts = new Map<string, number>();

  const active = await Promise.all(
    users.map(async (user) => (await getActiveSessions(user.id)).size),
  );
  users.forEach((user, index) => {
    const identity = userIdentity(user.id);
    byIdentity.set(identity, {
      name: user.name ?? user.email,
      detail: user.email,
      image: user.image,
    });
    runCounts.set(identity, active[index] ?? 0);
  });

  return { byIdentity, runCounts };
}

interface LoadedContainers {
  byIdentity: Map<string, "running" | "stopped">;
  /** False when the sandbox service is not configured or did not answer. */
  available: boolean;
}

async function loadContainers(): Promise<LoadedContainers> {
  const byIdentity = new Map<string, "running" | "stopped">();
  if (!sandboxClient.isConfigured()) return { byIdentity, available: false };
  try {
    for (const container of await sandboxClient.listContainers()) {
      byIdentity.set(container.identity, container.state === "running" ? "running" : "stopped");
    }
    return { byIdentity, available: true };
  } catch (err) {
    // Sizes still render; the container column reads `unknown`.
    console.error("Failed to list sandbox containers:", err);
    return { byIdentity, available: false };
  }
}

/** Total and free bytes of the filesystem the volume lives on. */
async function volumeSpace(dir: string): Promise<{ total: number; free: number } | null> {
  try {
    const stats = await fs.statfs(dir);
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch (err) {
    console.error(`Failed to read the filesystem stats of ${dir}:`, err);
    return null;
  }
}

/** Removing a directory that an account still owns is refused. */
export class WorkspaceOwnedError extends Error {
  constructor(identity: string) {
    super(`${identity} belongs to an account, so only its container can be reset`);
    this.name = "WorkspaceOwnedError";
  }
}

/** Forget one identity's size, so the next look asks for a fresh measurement. */
function forgetMeasurement(identity: string): void {
  measured?.bytes.delete(identity);
}

/** Remove a workspace's container. Its files stay, and the next command builds a new one. */
export async function removeWorkspaceContainer(identity: string): Promise<void> {
  const parsed = parseIdentity(identity);
  if (!sandboxClient.isConfigured()) throw new Error("SANDBOX_URL is not set");
  await sandboxClient.removeContainer(parsed);
}

/**
 * Delete a directory no account owns, and the container beside it.
 *
 * Ownership is checked again here: the page that offered this may be a minute
 * old.
 */
export async function deleteOrphanWorkspace(identity: string): Promise<void> {
  const parsed = parseIdentity(identity);
  if (await isOwned(parsed)) throw new WorkspaceOwnedError(parsed);
  await destroySandbox(parsed);
  forgetMeasurement(parsed);
}

/** Whether some account's workspace this identity is. */
async function isOwned(identity: string): Promise<boolean> {
  const users = await prisma.user.findMany({ select: { id: true } });
  return users.some((user) => userIdentity(user.id) === identity);
}
