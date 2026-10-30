export interface ChangelogItem {
  /** The commit subject, without its conventional prefix. */
  text: string;
  /** Short commit id, when the entry names one. */
  commit: string | null;
}

export interface ChangelogRelease {
  version: string;
  /** Release date, `YYYY-MM-DD`. */
  date: string;
  items: ChangelogItem[];
}

const RELEASE = /^##\s+(\S+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/;
const ITEM = /^-\s+(.*?)(?:\s+\(([0-9a-f]{7,40})\))?$/;

/** Reads `CHANGELOG.md` as `scripts/changelog.mjs` writes it. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();

    const release = RELEASE.exec(trimmed);
    if (release?.[1] && release[2]) {
      const entry: ChangelogRelease = { version: release[1], date: release[2], items: [] };
      releases.push(entry);
      current = entry;
      continue;
    }

    if (!current) continue;

    const item = ITEM.exec(trimmed);
    if (item?.[1]) current.items.push({ text: item[1].trim(), commit: item[2] ?? null });
  }

  return releases;
}

/** Where this build came from, so an entry can link to its commit. */
export const SOURCE_REPO = "Blumlaut/saale";

export function commitUrl(commit: string): string {
  return `https://github.com/${SOURCE_REPO}/commit/${commit}`;
}
