#!/usr/bin/env node
/**
 * Copy the old open-terminal homes into the workspaces volume.
 *
 * Run it while the old stack is still up: the old volume is mounted read-only,
 * the new one is written, and nothing is deleted. Identities are derived with
 * the same rules the app used to derive a Linux account from a user id, so each
 * `/home/<account>` lands in `user-<id>/` (or `council-<key>/`) with its
 * `uploads/`, `files/`, `images/` and `telegram_files/` intact.
 *
 *   node scripts/migrate-workspaces.mjs --dry-run   # what would be copied
 *   node scripts/migrate-workspaces.mjs             # copy
 *
 * A second run refuses to overwrite a destination that already has files unless
 * `--force` is passed, so re-running after the cutover cannot replace newer data
 * with older.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flag("dry-run");
const FORCE = flag("force");
const OLD_VOLUME = option("old", "saale_open-terminal-data");
const NEW_VOLUME = option("new", "saale_workspaces");
const POSTGRES = option("postgres", "saale-postgres");
const DB = option("db", "saale");
const DB_USER = option("db-user", "saale");
const USER_PREFIX = option("prefix", process.env.OPEN_TERMINAL_USER_PREFIX ?? "");
const OWNER = option("owner", "0:0");

/** Directories a workspace keeps. Anything else on top level is copied too. */
const WORKSPACE_DIRS = ["uploads", "files", "images", "telegram_files"];

/** Files that belong to the old shell account, not to the agent's workspace. */
const SKIP = new Set([".bashrc", ".bash_logout", ".profile", ".cache", ".local"]);

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

function docker(argv, options = {}) {
  return execFileSync("docker", argv, { encoding: "utf8", ...options });
}

function psql(sql) {
  return docker(["exec", POSTGRES, "psql", "-U", DB_USER, "-d", DB, "-tAc", sql]).trim();
}

function requireVolume(name) {
  try {
    docker(["volume", "inspect", name]);
  } catch {
    console.error(
      `Docker volume ${name} does not exist. Create it with: docker volume create ${name}`,
    );
    process.exit(1);
  }
}

async function main() {
  requireVolume(OLD_VOLUME);
  requireVolume(NEW_VOLUME);

  const userIds = psql('SELECT id FROM "user" ORDER BY id').split("\n").filter(Boolean);
  const councilKeys = psql('SELECT "sandboxKey" FROM "Council" ORDER BY "sandboxKey"')
    .split("\n")
    .filter(Boolean);

  if (userIds.length === 0 && councilKeys.length === 0) {
    console.error(
      "The database has no users or councils. Is --postgres pointing at the right container?",
    );
    process.exit(1);
  }

  const mapping = [
    ...userIds.map((id) => ({ account: deriveAccount(id), target: `user-${id}`, kind: "user" })),
    ...councilKeys.map((key) => ({
      account: deriveAccount(key),
      target: `council-${key}`,
      kind: "council",
    })),
  ];

  const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-migrate-"));
  const planPath = path.join(planDir, "plan.tsv");
  const scriptPath = path.join(planDir, "copy.sh");
  await fs.writeFile(planPath, mapping.map((row) => `${row.account}\t${row.target}`).join("\n"));
  await fs.writeFile(scriptPath, COPY_SCRIPT);

  const mode = DRY_RUN ? "dry-run" : "copy";
  // A one-shot operator script: its report is the point, so it writes to stdout.
  /* eslint-disable no-console */
  console.log(`${mode}: ${mapping.length} identities from ${OLD_VOLUME} into ${NEW_VOLUME}`);
  for (const row of mapping) console.log(`  /home/${row.account} → ${row.target}/ (${row.kind})`);
  /* eslint-enable no-console */

  try {
    const output = docker([
      "run",
      "--rm",
      "-v",
      `${OLD_VOLUME}:/old:ro`,
      ...(DRY_RUN ? [] : ["-v", `${NEW_VOLUME}:/new`]),
      "-v",
      `${planDir}:/plan:ro`,
      "-e",
      `MODE=${mode}`,
      "-e",
      `FORCE=${FORCE ? "1" : "0"}`,
      "-e",
      `OWNER=${OWNER}`,
      "-e",
      `SKIP=${[...SKIP].join(" ")}`,
      "-e",
      `WORKSPACE_DIRS=${WORKSPACE_DIRS.join(" ")}`,
      "alpine:3.20",
      "sh",
      "/plan/copy.sh",
    ]);

    // `docker run` output is the report; print it as it comes.
    process.stdout.write(output);
    if (output.includes("MISMATCH")) process.exit(2);
  } finally {
    await fs.rm(planDir, { recursive: true, force: true });
  }
}

/**
 * Runs inside the throwaway container. `plan.tsv` is the mapping, `/old` is the
 * old volume and `/new` the new one.
 *
 * Every copy is followed by a count and a byte total, and a destination that
 * does not match its source fails the run: a half-copied home is the one
 * outcome that must not pass silently.
 */
const COPY_SCRIPT = String.raw`#!/bin/sh
set -eu

# Everything the copy takes: the workspace directories plus non-hidden files on
# top level. The shell's own dotfiles are not part of a workspace.
list_files() {
  for entry in "$1"/*; do
    [ -e "$entry" ] || continue
    if [ -d "$entry" ]; then find "$entry" -type f; else echo "$entry"; fi
  done
}

count_files() { list_files "$1" | wc -l | tr -d ' '; }

count_bytes() {
  list_files "$1" > /tmp/count.list
  total=0
  while IFS= read -r file; do
    size=$(stat -c '%s' "$file" 2>/dev/null || echo 0)
    total=$((total + size))
  done < /tmp/count.list
  echo "$total"
}

# One account's home into one identity's directory.
copy_home() {
  src="$1"
  dest="$2"
  label="$3"

  mkdir -p "$dest"
  if [ -n "$(ls -A "$dest" 2>/dev/null)" ] && [ "$FORCE" != "1" ]; then
    echo "SKIP  $label: $dest already has files (pass --force to overwrite)"
    return 0
  fi

  for dir in $WORKSPACE_DIRS; do
    if [ -d "$src/$dir" ]; then
      mkdir -p "$dest/$dir"
      cp -a "$src/$dir/." "$dest/$dir/"
    fi
  done

  # Anything else on top level is the agent's own work; shell dotfiles are not.
  for entry in "$src"/* "$src"/.*; do
    name=$(basename "$entry")
    case "$name" in .|..|'*') continue ;; esac
    [ -e "$entry" ] || continue
    case " $SKIP " in *" $name "*) continue ;; esac
    case " $WORKSPACE_DIRS " in *" $name "*) continue ;; esac
    cp -a "$entry" "$dest/"
  done

  # The old homes belonged to open-terminal's accounts, which do not exist here.
  # Pass --owner=<SANDBOX_UID>:<SANDBOX_GID> when commands run as agent.
  chown -R "$OWNER" "$dest" 2>/dev/null || echo "WARN  could not chown $dest to $OWNER"

  before_files=$(count_files "$src")
  before_bytes=$(count_bytes "$src")
  after_files=$(count_files "$dest")
  after_bytes=$(count_bytes "$dest")
  if [ "$before_files" != "$after_files" ] || [ "$before_bytes" != "$after_bytes" ]; then
    echo "MISMATCH $label: $before_files files / $before_bytes bytes → $after_files / $after_bytes"
  else
    echo "OK    $label: $after_files files / $after_bytes bytes"
  fi
}

# /plan/plan.tsv is one "account<TAB>target" pair per line.
matched=""
while IFS="$(printf '\t')" read -r account target; do
  [ -n "$account" ] || continue
  matched="$matched $account"

  if [ -d "/old/$account" ]; then
    if [ "$MODE" = "copy" ]; then
      copy_home "/old/$account" "/new/$target" "$account → $target"
    else
      echo "PLAN  $account → $target: $(count_files "/old/$account") files / $(count_bytes "/old/$account") bytes"
    fi
  else
    echo "MISS  $account: no home directory in the old volume"
  fi
done < /plan/plan.tsv

# Homes nobody in the database claims: keep them, but out of the way.
for home in /old/*; do
  [ -d "$home" ] || continue
  account=$(basename "$home")
  case " $matched " in *" $account "*) continue ;; esac
  if [ "$MODE" = "copy" ]; then
    mkdir -p "/new/_orphaned"
    cp -a "$home" "/new/_orphaned/$account"
    echo "ORPHAN $account: copied to _orphaned/$account"
  else
    echo "ORPHAN $account: would be copied to _orphaned/$account"
  fi
done
`;

void main();
