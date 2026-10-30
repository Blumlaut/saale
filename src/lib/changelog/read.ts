import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseChangelog, type ChangelogRelease } from "./parse";

/** `CHANGELOG.md` ships inside the image, so this reads the running release offline. */
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
