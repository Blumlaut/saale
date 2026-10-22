/**
 * Scratch directories inside the workspaces volume.
 *
 * A workspace's `.tmp` is where a command puts throwaway output. Left alone it
 * grows with the volume, so the sandbox service sweeps entries past a
 * configured age.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundError } from "@/lib/files/errors";
import { WORKSPACE_TMP_DIR } from "./workspace";

export interface TmpSweepOptions {
  /** Age at which an entry is removed. Zero disables the sweep. */
  olderThanMs: number;
  /** Clock, for tests. */
  at?: number | undefined;
}

export interface TmpSweepResult {
  /** Entries removed. */
  removed: number;
  /** Workspaces that had a scratch directory. */
  workspaces: number;
}

export async function sweepWorkspaceTmp(
  workspacesDir: string,
  options: TmpSweepOptions,
): Promise<TmpSweepResult> {
  const result: TmpSweepResult = { removed: 0, workspaces: 0 };
  if (!(options.olderThanMs > 0)) return result;

  const cutoff = (options.at ?? Date.now()) - options.olderThanMs;
  let identities: string[];
  try {
    identities = (await fs.readdir(workspacesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    console.error(`Failed to list workspaces in ${workspacesDir}:`, err);
    return result;
  }

  for (const identity of identities) {
    const tmp = path.join(workspacesDir, identity, WORKSPACE_TMP_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(tmp);
    } catch (err) {
      // Most workspaces never use it; there is nothing to sweep.
      if (!isNotFoundError(err)) console.error(`Failed to list ${tmp}:`, err);
      continue;
    }

    result.workspaces += 1;
    for (const entry of entries) {
      const target = path.join(tmp, entry);
      try {
        const stat = await fs.lstat(target);
        if (stat.mtimeMs > cutoff) continue;
        await fs.rm(target, { recursive: true, force: true });
        result.removed += 1;
      } catch (err) {
        if (isNotFoundError(err)) continue;
        console.error(`Failed to remove scratch entry ${target}:`, err);
      }
    }
  }

  return result;
}
