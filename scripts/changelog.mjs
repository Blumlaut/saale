#!/usr/bin/env node
/**
 * Writes the changelog section for a release out of the commits since the last
 * tag. The release workflow runs it before the image build and again before the
 * release commit.
 *
 *   node scripts/changelog.mjs --version 2026.10.0            # print it
 *   node scripts/changelog.mjs --version 2026.10.0 --write    # into CHANGELOG.md
 *   node scripts/changelog.mjs --version 2026.10.0 --notes out.md
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HEADING = "# Changelog";
const FILE = "CHANGELOG.md";
/** `feat(chat): x` reads as `x` in a list meant for users. */
const CONVENTIONAL =
  /^(?:feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(?:\([^)]*\))?!?:\s*/i;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    date: { type: "string" },
    write: { type: "boolean", default: false },
    notes: { type: "string" },
  },
});

if (!values.version) {
  console.error("changelog: --version is required");
  process.exit(1);
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "[0-9]*");
  } catch {
    return "";
  }
}

function items() {
  const from = lastTag();
  if (!from) return [];

  return git("log", "--no-merges", "--format=%h\t%s", `${from}..HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, subject]) => !/^release\b/i.test(subject))
    .map(([commit, subject]) => ({ commit, text: subject.replace(CONVENTIONAL, "").trim() }));
}

function section() {
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const rows = items();
  const body = rows.length
    ? rows.map((row) => `- ${row.text} (${row.commit})`).join("\n")
    : lastTag()
      ? "- No changes recorded."
      : "- First release.";

  return `## ${values.version} - ${date}\n\n${body}\n`;
}

/** Newest section first, under the file's own heading. */
function prepend(markdown) {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.startsWith("# "));
  if (at === -1) return `${HEADING}\n\n${section()}\n${markdown}`;

  const rest = lines
    .slice(at + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return `${lines.slice(0, at + 1).join("\n")}\n\n${section()}${rest ? `\n${rest}` : ""}`;
}

const notes = section();

if (values.notes) {
  writeFileSync(values.notes, notes);
}

if (values.write) {
  const path = join(process.cwd(), FILE);
  const markdown = existsSync(path) ? readFileSync(path, "utf8") : `${HEADING}\n`;
  if (markdown.includes(`## ${values.version} `)) {
    process.stdout.write(`changelog: ${values.version} is already in ${FILE}\n`);
  } else {
    writeFileSync(path, prepend(markdown));
    process.stdout.write(`changelog: wrote ${values.version} into ${FILE}\n`);
  }
}

if (!values.write && !values.notes) {
  process.stdout.write(notes);
}
