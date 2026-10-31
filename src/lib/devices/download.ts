/**
 * Where the desktop agent is downloaded from.
 *
 * The app ships with the release it talks to: the assets are attached to the
 * same tag as the images, so a running instance always offers the agent of its
 * own version. `SAALE_DESKTOP_RELEASE_BASE` points a fork at its own releases.
 */

import { APP_VERSION } from "@/lib/version";

/** Owner/repo whose releases carry the agent builds. */
const DEFAULT_RELEASE_BASE = "https://github.com/Blumlaut/saale/releases/download";

export interface DesktopDownload {
  /** What the button says. */
  label: string;
  /** Asset file name, also what the install line unpacks. */
  file: string;
  url: string;
}

/** Version this instance runs, or "dev" in a development build. */
function releaseVersion(): string | null {
  return /^\d/.test(APP_VERSION) ? APP_VERSION : null;
}

/**
 * The agent builds for this version. Empty in a development build, where there
 * is no release to point at and the settings page says so instead of offering
 * a link that 404s.
 */
export function getDesktopDownloads(): DesktopDownload[] {
  const version = releaseVersion();
  if (!version) return [];

  // Releases are tagged with the bare version (`2026.10.2`), not a `v` prefix.
  const base = `${process.env.SAALE_DESKTOP_RELEASE_BASE ?? DEFAULT_RELEASE_BASE}/${version}`;
  const file = `saale-agent-${version}-x86_64-linux.tar.gz`;

  return [{ label: "Linux (x86_64)", file, url: `${base}/${file}` }];
}
