/**
 * The release this build came from, as the console footer shows it.
 *
 * An image build passes it in; a checkout falls back to `package.json` through
 * `next.config.ts`, and a build with neither says `dev`.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

/**
 * Positive when `a` is the newer version.
 *
 * Only what a release tag needs: dotted numbers, and a prerelease (`-beta.1`)
 * sorting below the release it precedes.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre] = a.split("-", 2);
  const [bCore = "", bPre] = b.split("-", 2);
  const aParts = aCore.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = bCore.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre, undefined, { numeric: true });
}
