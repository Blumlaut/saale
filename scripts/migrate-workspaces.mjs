#!/usr/bin/env node
/**
 * Copy the old open-terminal homes into the workspaces volume, once.
 *
 * Runs as a one-shot compose service between the schema migration and
 * web/worker. A marker file in the new volume records that the move happened;
 * every later deploy sees it and exits without touching anything.
 *
 * Each copy lands in a temporary directory that is renamed into place, so an
 * interrupted run cannot leave half a workspace behind, and the marker is only
 * written once every workspace is complete. The old volume is mounted
 * read-only, so nothing here can lose data.
 *
 *   docker compose run --rm workspaces-migrate --dry-run
 *   docker compose run --rm workspaces-migrate            # normal: skipped if done
 *   docker compose run --rm workspaces-migrate --force    # redo it anyway
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

const OLD_ROOT = process.env.OLD_WORKSPACES_DIR ?? "/migrate/old";
const NEW_ROOT = process.env.SANDBOX_WORKSPACES_DIR ?? "/workspaces";
const MARKER = path.join(NEW_ROOT, ".migrated-from-open-terminal");
const UID = Number(process.env.SANDBOX_UID ?? "1000");
const GID = Number(process.env.SANDBOX_GID ?? "1000");
const USER_PREFIX = process.env.OPEN_TERMINAL_USER_PREFIX ?? "";

/**
 * What belongs in the workspace.
 *
 * The old shell account's own files and caches stay behind; `~/.local/bin` and
 * `~/.local/lib` come along, because that is where an agent's own installs
 * live and they must survive the move.
 */
function copies(relative) {
  const segments = relative.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (name === ".cache" || name === ".profile" || name.startsWith(".bash")) return false;
  if (segments.length === 2 && segments[0] === ".local" && name === "state") return false;
  return true;
}

/**
 * The account open-terminal created for an id: its first eight alphanumerics,
 * or a hash when the id is shorter, behind an optional operator prefix.
 */
function deriveAccount(id) {
  const cleaned = id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const name =
    cleaned.length >= 4
      ? cleaned.slice(0, 8)
      : crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
  const full = `${USER_PREFIX}${name}`;
  return /^[0-9]/.test(full) ? `u${full}` : full;
}

/** Everything a copy takes, as `{ file, bytes }`, so two runs can be compared. */
async function measure(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!copies(relative)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await measure(full, relative)));
    } else if (entry.isFile()) {
      const stats = await fs.stat(full);
      files.push({ file: full, bytes: stats.size });
    }
  }
  return files;
}

async function summarise(dir) {
  const files = await measure(dir);
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

async function chownTree(dir) {
  await fs.chown(dir, UID, GID);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(full);
    else await fs.chown(full, UID, GID);
  }
}

function warn(message) {
  console.error(`WARN  ${message}`);
}

function log(message) {
  // A deploy log is the whole point of this script.
  // eslint-disable-next-line no-console
  console.log(message);
}

/** Whether a path exists. A missing path is expected; anything else is not. */
async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") warn(`stat ${target}: ${err.message}`);
    return false;
  }
}

/** Whether a destination already holds a workspace we must not overwrite. */
async function hasFiles(dir) {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch (err) {
    if (err.code !== "ENOENT") warn(`read ${dir}: ${err.message}`);
    return false;
  }
}

/**
 * Copy one old home into one identity directory.
 *
 * The copy is assembled beside the destination and renamed onto it, so the
 * volume never holds a workspace that is only half there.
 */
async function copyHome(source, destination, label) {
  const before = await summarise(source);

  if (DRY_RUN) {
    log(`PLAN  ${label}: ${before.files} files / ${before.bytes} bytes`);
    return true;
  }

  if (await hasFiles(destination)) {
    if (!FORCE) {
      log(`SKIP  ${label}: already has files`);
      return true;
    }
    await fs.rm(destination, { recursive: true, force: true });
  }

  const staging = `${destination}.migrating`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  try {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await fs.cp(path.join(source, entry.name), path.join(staging, entry.name), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: (candidate) => copies(path.relative(source, candidate).split(path.sep).join("/")),
      });
    }

    await chownTree(staging);
    const after = await summarise(staging);
    if (after.files !== before.files || after.bytes !== before.bytes) {
      throw new Error(
        `copy mismatch for ${label}: ${before.files} files / ${before.bytes} bytes ` +
          `→ ${after.files} / ${after.bytes}`,
      );
    }

    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
    log(`OK    ${label}: ${after.files} files / ${after.bytes} bytes`);
    return true;
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    console.error(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Identity → old account, for every user and council the database knows. */
async function identities() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const users = await client.query('SELECT id FROM "user" ORDER BY id');
    const councils = await client.query('SELECT "sandboxKey" FROM "Council" ORDER BY "sandboxKey"');

    return [
      ...users.rows.map((row) => ({
        account: deriveAccount(row.id),
        target: `user-${row.id}`,
      })),
      ...councils.rows.map((row) => ({
        account: deriveAccount(row.sandboxKey),
        target: `council-${row.sandboxKey}`,
      })),
    ];
  } finally {
    await client.end();
  }
}

async function main() {
  const mode = DRY_RUN ? "dry-run" : "copy";
  log(`${mode}: ${OLD_ROOT} → ${NEW_ROOT}`);

  const done = await readMarker();
  if (done && !FORCE) {
    log(`already migrated at ${done.trim()}: nothing to do`);
    return 0;
  }

  if (!(await exists(OLD_ROOT))) {
    log(`no old volume mounted at ${OLD_ROOT}: nothing to migrate`);
    if (!DRY_RUN) await writeMarker();
    return 0;
  }

  const mapping = await identities();
  const matched = new Set();
  let failures = 0;

  for (const { account, target } of mapping) {
    matched.add(account);
    const source = path.join(OLD_ROOT, account);
    if (!(await exists(source))) continue;

    const ok = await copyHome(source, path.join(NEW_ROOT, target), `${account} → ${target}`);
    if (!ok) failures += 1;
  }

  // Homes nobody in the database claims: keep them, out of the way.
  for (const entry of await fs.readdir(OLD_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || matched.has(entry.name)) continue;
    const source = path.join(OLD_ROOT, entry.name);
    if (DRY_RUN) {
      log(`ORPHAN ${entry.name}: would be copied to _orphaned/${entry.name}`);
      continue;
    }
    const destination = path.join(NEW_ROOT, "_orphaned", entry.name);
    if (await hasFiles(destination)) {
      log(`ORPHAN ${entry.name}: already in _orphaned/${entry.name}`);
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, `${destination}.migrating`, { recursive: true, preserveTimestamps: true });
    await chownTree(`${destination}.migrating`);
    await fs.rename(`${destination}.migrating`, destination);
    log(`ORPHAN ${entry.name}: copied to _orphaned/${entry.name}`);
  }

  if (failures > 0) {
    console.error(`${failures} workspace(s) failed: marker not written, next deploy retries`);
    return 1;
  }
  if (!DRY_RUN) await writeMarker();
  return 0;
}

/** The marker's timestamp, or null when the volume has not been migrated. */
async function readMarker() {
  try {
    return await fs.readFile(MARKER, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") warn(`read ${MARKER}: ${err.message}`);
    return null;
  }
}

/** Records that the move happened, so later deploys leave the volume alone. */
async function writeMarker() {
  await fs.writeFile(MARKER, `${new Date().toISOString()}\n`, { flag: "w" });
  await fs.chown(MARKER, UID, GID).catch((err) => warn(`chown ${MARKER}: ${err.message}`));
  log(`marked ${MARKER}`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("migration failed:", err);
    process.exit(1);
  });
