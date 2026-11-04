/**
 * The newest release GitHub knows about, so a running instance can say whether
 * it is behind.
 *
 * One lookup serves the whole instance for an hour: the console footer asks on
 * every page load, and GitHub allows 60 unauthenticated requests an hour per
 * address. A failed lookup is remembered briefly, so a deployment without
 * outbound access does not retry on every page.
 */

import { z } from "zod";

import { parseChangelog, SOURCE_REPO, type ChangelogItem } from "@/lib/changelog/parse";
import { APP_VERSION, compareVersions } from "@/lib/version";

const RELEASES_URL = `https://api.github.com/repos/${SOURCE_REPO}/releases/latest`;
const CACHE_MS = 60 * 60 * 1000;
const FAILED_CACHE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

/** An optional token lifts the hourly limit for an instance that asks often. */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

export interface LatestRelease {
  version: string;
  /** `YYYY-MM-DD`, as the release notes name it. */
  date: string;
  items: ChangelogItem[];
  /** The release page, for the notes the console does not parse. */
  url: string;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  published_at: z.string().optional(),
  body: z.string().nullable().optional(),
});

type ReleaseCache = { at: number; ttl: number; release: LatestRelease | null };

let cached: ReleaseCache | null = null;
let inflight: Promise<LatestRelease | null> | null = null;

/** The release notes are a `CHANGELOG.md` section; the tag names the version. */
function toRelease(payload: unknown): LatestRelease | null {
  const parsed = releaseSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("Latest release response did not match:", parsed.error.issues);
    return null;
  }

  const section = parseChangelog(parsed.data.body ?? "")[0];
  const date = section?.date ?? parsed.data.published_at?.slice(0, 10) ?? "";

  return {
    version: parsed.data.tag_name,
    date,
    items: section?.items ?? [],
    url: parsed.data.html_url,
  };
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`Latest release lookup returned ${response.status}`);
      return null;
    }

    return toRelease(await response.json());
  } catch (err) {
    console.error("Failed to look up the latest release:", err);
    return null;
  }
}

/** The newest published release, or `null` when GitHub cannot answer. */
export async function getLatestRelease(): Promise<LatestRelease | null> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.release;

  if (!inflight) {
    inflight = fetchLatestRelease().then(
      (release) => {
        cached = { at: Date.now(), ttl: release ? CACHE_MS : FAILED_CACHE_MS, release };
        inflight = null;
        return release;
      },
      (err: unknown) => {
        inflight = null;
        throw err;
      },
    );
  }

  return inflight;
}

/**
 * Whether `current` could move to `latest`.
 *
 * A build without a release (`dev`) has nothing to compare against; the footer
 * stays as it is and the console never claims an update.
 */
export function isUpdateAvailable(latest: LatestRelease | null, current = APP_VERSION): boolean {
  if (!latest || current === "dev") return false;
  return compareVersions(latest.version, current) > 0;
}

/** Test seam: forget the cached answer. */
export function resetLatestReleaseCache(): void {
  cached = null;
  inflight = null;
}
