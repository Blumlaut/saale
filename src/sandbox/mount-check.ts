/**
 * The kernel view of a container, read back rather than assumed.
 *
 * A container is only accepted when `/proc/self/mountinfo` inside it shows one
 * mount under the workspaces root, and that mount is the identity's own
 * directory. Docker's `volume-subpath` is the mechanism; this is the check that
 * the mechanism did what the spec asked, run before the container is used.
 */

export interface MountCheck {
  ok: boolean;
  /** Why it was refused, for the log and the request's error. */
  reason?: string;
  /** Mount points this container has under the workspaces root. */
  mountPoints: string[];
}

/** The mount point field of one `/proc/self/mountinfo` line (escaped spaces aside). */
function mountPoint(line: string): string | null {
  const fields = line.split(" ");
  return fields.length > 4 ? (fields[4] ?? null) : null;
}

/** identity-aware check of `cat /proc/self/mountinfo` output. */
export function checkMountinfo(
  mountinfo: string,
  options: { identity: string; workspacesDir: string },
): MountCheck {
  const expected = `${options.workspacesDir}/${options.identity}`;
  const prefix = `${options.workspacesDir}/`;

  const mountPoints = mountinfo
    .split("\n")
    .map(mountPoint)
    .filter((point): point is string => !!point && point.startsWith(prefix));

  if (mountPoints.length === 0) {
    return {
      ok: false,
      reason: `no ${options.workspacesDir} mount inside the container`,
      mountPoints,
    };
  }
  if (mountPoints.length > 1) {
    return {
      ok: false,
      reason: `expected one ${options.workspacesDir} mount, found ${mountPoints.length}`,
      mountPoints,
    };
  }
  if (mountPoints[0] !== expected) {
    return {
      ok: false,
      reason: `mounted ${mountPoints[0]} instead of ${expected}`,
      mountPoints,
    };
  }
  return { ok: true, mountPoints };
}
