/**
 * What each workspace occupies on the volume.
 *
 * One `du` counts every identity and runs off the event loop. The runtime image
 * is Alpine, where `du` is busybox's, and `-k` is the flag it shares with
 * coreutils.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundError } from "@/lib/files/errors";
import { isSandboxIdentity } from "./identity";

/** One identity's footprint. `bytes` is apparent size, the number `du` reports. */
export interface WorkspaceUsage {
  identity: string;
  bytes: number;
}

/** Longest a measurement may run before it is killed. */
const MEASURE_TIMEOUT_MS = 10 * 60_000;

/** The output is one line per identity, so this is generous. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Directory names in the volume that name a workspace. */
export async function listWorkspaceIdentities(workspacesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(workspacesDir);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    console.error(`Failed to list workspaces in ${workspacesDir}:`, err);
    throw err;
  }
  return entries.filter(isSandboxIdentity).sort();
}

/**
 * Measure every identity in one `du` call.
 *
 * An identity whose directory vanished between the listing and the measurement
 * is absent from the result rather than zero, so a caller can tell "empty" from
 * "not there".
 */
export async function measureWorkspaceUsage(
  workspacesDir: string,
  identities: readonly string[],
): Promise<WorkspaceUsage[]> {
  if (identities.length === 0) return [];
  const dirs = identities.map((identity) => path.join(workspacesDir, identity));
  const output = await runDu(dirs);
  const bytesByIdentity = new Map<string, number>();
  for (const line of output.split("\n")) {
    const parsed = parseDuLine(line);
    if (!parsed) continue;
    bytesByIdentity.set(path.basename(parsed.path), parsed.bytes);
  }
  return identities
    .filter((identity) => bytesByIdentity.has(identity))
    .map((identity) => ({ identity, bytes: bytesByIdentity.get(identity) ?? 0 }));
}

/**
 * One `du -sk` line: KiB, then the path it counted.
 *
 * The split is on the first whitespace run, so a path holding a space arrives
 * whole.
 */
export function parseDuLine(line: string): { bytes: number; path: string } | null {
  const match = /^(\d+)\s+(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return null;
  return { bytes: Number(match[1]) * 1024, path: match[2] };
}

function runDu(dirs: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Not a shell: one argv per path, so a directory name is never a command.
    const child = spawn("du", ["-sk", ...dirs], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`du did not finish within ${MEASURE_TIMEOUT_MS / 60_000} minutes`));
    }, MEASURE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) return;
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A directory gone since the listing makes du exit 1, and it still
      // counted the rest.
      if (code === 0 || (code === 1 && stdout.length > 0)) {
        if (stderr) console.warn(`du could not count every workspace: ${stderr.trim()}`);
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      if (stderr) console.error(`du exited ${code}: ${stderr.trim()}`);
      reject(new Error(`du exited with ${code}`));
    });
  });
}
