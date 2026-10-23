#!/usr/bin/env node
/**
 * Rename the workspaces volume to the short identities the app now derives.
 *
 * A user's directory used to be `user-<userId>`, 30+ characters repeated by
 * every path an agent inside it read or typed. It is now `user-<key>`, a
 * 12-hex-character digest of the id (see `src/lib/sandbox/identity.ts`). This
 * script moves the directories the old scheme created, so a deploy does not
 * hand every user an empty workspace.
 *
 * It needs the volume and nothing else: the old name carries the user id, and
 * the new key is derived from it, so no database connection is involved.
 *
 *   node scripts/migrate-workspace-keys.mjs /w --dry-run
 *   node scripts/migrate-workspace-keys.mjs /w
 *   node scripts/migrate-workspace-keys.mjs /w --prune-containers
 *
 * `--prune-containers` removes every tenant container (they are disposable and
 * recreated on demand). It is not optional in practice: a container binds its
 * mount subpath at start, so one that is still running keeps the directory
 * under its old name. It needs `/var/run/docker.sock`, so run the script where
 * that socket is available, or run the printed `docker` command yourself.
 *
 * Idempotent: a directory already named by a key is left alone.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Kept in step with `USER_WORKSPACE_KEY_NAMESPACE`/`LENGTH` by a test. */
export const KEY_NAMESPACE = "saale-user-workspace:v1";
export const KEY_LENGTH = 12;

/** A directory that already carries a key: hex only, exactly `KEY_LENGTH`. */
const KEY_PATTERN = new RegExp(`^[0-9a-f]{${KEY_LENGTH}}$`);

/**
 * Shortest suffix treated as a legacy user id.
 *
 * Every id this app ever issued is 25 (cuid) or 32 (better-auth) characters, so
 * anything shorter is not one and is left for a human to look at rather than
 * silently renamed.
 */
const MIN_LEGACY_ID_LENGTH = 20;

/** The directory name for `userId` under the current scheme. */
export function workspaceKey(userId) {
  return createHash("sha256")
    .update(`${KEY_NAMESPACE}:${userId}`)
    .digest("hex")
    .slice(0, KEY_LENGTH);
}

/** What to do with one entry of the volume. */
export function classify(name) {
  if (!name.startsWith("user-")) return { action: "skip", reason: "not a user directory" };
  const suffix = name.slice("user-".length);
  if (KEY_PATTERN.test(suffix)) return { action: "skip", reason: "already migrated" };
  if (suffix.length < MIN_LEGACY_ID_LENGTH) {
    return { action: "unknown", reason: `${suffix.length}-character suffix is not a known id` };
  }
  return { action: "rename", from: name, to: `user-${workspaceKey(suffix)}` };
}

/** Ask the Docker socket for the tenant containers it is running. */
function dockerRequest(socketPath, pathName, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: pathName, method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Remove every container that holds a workspace mount. */
export async function pruneContainers(socketPath = "/var/run/docker.sock") {
  const filter = encodeURIComponent('{"label":["saale.sandbox"]}');
  const listed = await dockerRequest(socketPath, `/containers/json?all=1&filters=${filter}`);
  if (listed.status !== 200) throw new Error(`Docker listed containers with ${listed.status}`);

  const containers = JSON.parse(listed.body);
  let removed = 0;
  for (const container of containers) {
    const reply = await dockerRequest(socketPath, `/containers/${container.Id}?force=1`, "DELETE");
    if (reply.status >= 400) {
      console.error(`Failed to remove ${container.Names?.[0] ?? container.Id}: ${reply.status}`);
      continue;
    }
    removed += 1;
  }
  return { found: containers.length, removed };
}

/**
 * Move every legacy directory in `root`.
 *
 * A target that already exists is reported and left untouched: two directories
 * for one user is a decision for a human, not something to merge blind.
 */
export async function migrate(root, { dryRun = false, log = console.log } = {}) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const renamed = [];
  const skipped = [];
  const unknown = [];
  const conflicts = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const verdict = classify(entry.name);
    if (verdict.action === "skip") {
      skipped.push({ name: entry.name, reason: verdict.reason });
      continue;
    }
    if (verdict.action === "unknown") {
      unknown.push({ name: entry.name, reason: verdict.reason });
      continue;
    }

    const to = path.join(root, verdict.to);
    const taken = await fs
      .stat(to)
      .then(() => true)
      .catch(() => false);
    if (taken) {
      conflicts.push({ from: entry.name, to: verdict.to });
      continue;
    }

    if (!dryRun) await fs.rename(path.join(root, entry.name), to);
    renamed.push({ from: entry.name, to: verdict.to });
    log(`${dryRun ? "would rename" : "renamed"} ${entry.name} → ${verdict.to}`);
  }

  return { renamed, skipped, unknown, conflicts, dryRun };
}

async function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const prune = args.includes("--prune-containers");
  const socketFlag = args.indexOf("--docker-socket");
  const socketPath = socketFlag >= 0 ? args[socketFlag + 1] : "/var/run/docker.sock";
  const root = args.find((arg) => !arg.startsWith("--") && arg !== socketPath);

  if (!root) {
    console.error(
      "Usage: migrate-workspace-keys.mjs <workspaces-dir> [--dry-run] [--prune-containers]",
    );
    process.exitCode = 2;
    return;
  }

  const result = await migrate(root, { dryRun });
  console.log(
    `${result.renamed.length} renamed, ${result.conflicts.length} conflicting, ` +
      `${result.unknown.length} unrecognised, ${result.skipped.length} left alone`,
  );

  for (const conflict of result.conflicts) {
    console.error(
      `Both ${conflict.from} and ${conflict.to} exist: merge by hand, nothing was moved.`,
    );
  }
  for (const entry of result.unknown) {
    console.error(`Left ${entry.name} alone: ${entry.reason}.`);
  }

  if (result.renamed.length === 0) return;

  if (prune) {
    try {
      const pruned = await pruneContainers(socketPath);
      console.log(`Removed ${pruned.removed} of ${pruned.found} tenant containers.`);
    } catch (err) {
      console.error(`Could not reach the Docker socket at ${socketPath}:`, err);
      console.error(
        "Remove the stale containers yourself: docker ps -aq --filter label=saale.sandbox | xargs -r docker rm -f",
      );
    }
  } else {
    console.log("Stale tenant containers still mount the old names; remove them:");
    console.log("  docker ps -aq --filter label=saale.sandbox | xargs -r docker rm -f");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("Workspace key migration failed:", err);
    process.exitCode = 1;
  });
}
