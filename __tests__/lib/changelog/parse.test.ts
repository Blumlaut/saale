import { describe, expect, it } from "vitest";

import { parseChangelog } from "@/lib/changelog/parse";

const FILE = `# Changelog

Each release gets a section here, written from the commits since the last tag.

## 2026.10.1 - 2026-10-31

- fix the sidebar footer on 320px (b1c2d3e)
- retire the telegram home thread, add /new (a4b5c6d)

## 2026.10.0 - 2026-10-30

- First release.

## 2026.9.0 - 2026-09-30
`;

describe("parseChangelog", () => {
  it("reads every release, newest first, and skips the prose above them", () => {
    const releases = parseChangelog(FILE);

    expect(releases.map((release) => release.version)).toEqual([
      "2026.10.1",
      "2026.10.0",
      "2026.9.0",
    ]);
    expect(releases[0]?.date).toBe("2026-10-31");
    expect(releases[2]?.items).toEqual([]);
  });

  it("keeps a subject that has its own parentheses", () => {
    const releases = parseChangelog(`## 2026.10.1 - 2026-10-31\n\n- fix x (y) and z (a4b5c6d)\n`);

    expect(releases[0]?.items).toEqual([{ text: "fix x (y) and z", commit: "a4b5c6d" }]);
  });

  it("leaves the commit out when an entry has none", () => {
    const releases = parseChangelog(`## 2026.10.0 - 2026-10-30\n\n- First release.\n`);

    expect(releases[0]?.items).toEqual([{ text: "First release.", commit: null }]);
  });

  it("returns nothing for a file without releases", () => {
    expect(parseChangelog("# Changelog\n\nNothing yet.\n")).toEqual([]);
  });
});
