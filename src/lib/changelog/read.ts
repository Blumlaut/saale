import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseChangelog, type ChangelogRelease } from "./parse";

/**
 * `CHANGELOG.md` ships inside the image next to the app, so the console can
 * show what the running release changed without asking anyone.
 */
let cached: Promise<ChangelogRelease[]> | undefined;

export function getChangelog(): Promise<ChangelogRelease[]> {
  cached ??= readFile(join(process.cwd(), "CHANGELOG.md"), "utf8")
    .then(parseChangelog)
    .catch((err: unknown) => {
      console.error("Failed to read CHANGELOG.md:", err);
      return [];
    });

  return cached;
}
