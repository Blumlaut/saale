/**
 * Where the desktop agent is downloaded from.
 *
 * A packaged agent served by this instance wins: a checkout builds one with
 * `npm run agent:package` and it lands in `public/downloads/`, so a development
 * build offers a real download instead of a release asset that does not exist
 * yet. Without one, the release of the version this instance runs is the
 * source, since the agent ships on the same tag as the images.
 *
 * `SAALE_DESKTOP_RELEASE_BASE` points a fork at its own releases.
 */

import fs from "fs/promises";
import path from "path";
import { APP_VERSION } from "@/lib/version";

/** Owner/repo whose releases carry the agent builds. */
const DEFAULT_RELEASE_BASE = "https://github.com/Blumlaut/saale/releases/download";

/** Where a locally packaged agent is served from, under `public/`. */
const LOCAL_DIR = "downloads";

/** The assets a release carries, and what a checkout packages. */
const ASSETS = [
  { label: "AppImage (x86_64)", suffix: "-x86_64.AppImage" },
  { label: "Linux tarball (x86_64)", suffix: "-x86_64-linux.tar.gz" },
] as const;

/** The file name of one asset for a version, so the install line is predictable. */
function assetName(version: string, suffix: string): string {
  return `saale-agent-${version}${suffix}`;
}

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
 * The agent builds on offer.
 *
 * The entry is a build this instance serves itself when one was packaged,
 * otherwise the release asset of its own version. Empty when neither exists:
 * the settings page then explains how to make one instead of offering a dead
 * link.
 */
export async function getDesktopDownloads(): Promise<DesktopDownload[]> {
  const local = await findLocalAgents();
  if (local.length > 0) {
    return local.map((name) => ({
      label: labelFor(name),
      file: name,
      url: `/api/devices/download/${name}`,
    }));
  }

  const version = releaseVersion();
  if (!version) return [];

  // Releases are tagged with the bare version (`2026.10.2`), not a `v` prefix.
  const base = `${process.env.SAALE_DESKTOP_RELEASE_BASE ?? DEFAULT_RELEASE_BASE}/${version}`;

  return ASSETS.map((asset) => {
    const file = assetName(version, asset.suffix);
    return { label: asset.label, file, url: `${base}/${file}` };
  });
}

/**
 * The absolute path of one packaged agent, or null when this instance has no
 * such file. The name is checked against what is on disk, so a request cannot
 * walk out of the directory.
 */
export async function packagedAgent(name: string): Promise<string | null> {
  const agents = await findLocalAgents();
  if (!agents.includes(name)) return null;
  return path.join(process.cwd(), "public", LOCAL_DIR, name);
}

/** What a packaged file is, from its own name. */
function labelFor(name: string): string {
  const asset = ASSETS.find((candidate) => name.endsWith(candidate.suffix));
  return asset?.label ?? "Linux (x86_64)";
}

/** The agents packaged into `public/downloads/`, newest name first. */
async function findLocalAgents(): Promise<string[]> {
  const dir = path.join(process.cwd(), "public", LOCAL_DIR);
  const entries = await fs.readdir(dir).catch((err: unknown) => {
    // A checkout that never packaged one has no directory, which is not a fault.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to look for a packaged desktop agent in ${dir}:`, err);
    }
    return [] as string[];
  });

  return entries
    .filter((name) => name.startsWith("saale-agent-"))
    .filter((name) => ASSETS.some((asset) => name.endsWith(asset.suffix)))
    .sort();
}
