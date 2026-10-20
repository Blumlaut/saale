/**
 * Path resolution for workspace files.
 *
 * A client sends a path; the server decides what it means. The rule is textual
 * and deliberately strict: `.` and empty segments collapse, `..` pops, a
 * relative path is taken from the root, and the result must be the root itself
 * or sit under it. compared with a separator (`/root/child`, never
 * `/root-child`), because a bare `startsWith` would let a sibling directory
 * through.
 *
 * Textual means a symlink *inside* the root can still point outside it. What
 * makes that harmless differs per backend and lives in the providers: for a
 * workspace account it is the kernel's own file permissions, for the app's
 * uploads volume it is a `realpath` check.
 *
 * This is the same rule the council sandbox applies to its members' tool
 * arguments. extracted here so both share one implementation rather than two
 * that drift.
 */

import { FilePathEscapeError } from "./errors";

/** The root without a trailing separator, so `root + "/"` prefixes are exact. */
function withoutTrailingSlash(root: string): string {
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

/**
 * Resolve `path` inside `root`.
 *
 * `inside` is false when the result is neither the root nor under it, in which
 * case `path` is the root. callers that want to refuse use
 * {@link requireWithinRoot} instead of inspecting this.
 */
export function resolveWithinRoot(root: string, path: string): { path: string; inside: boolean } {
  const base = withoutTrailingSlash(root);
  // A NUL byte can truncate a path inside a syscall, so it never reaches one.
  if (path.includes("\0")) return { path: base, inside: false };

  const absolute = path.startsWith("/") ? path : `${base}/${path}`;

  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { path: base, inside: false };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const normalized = `/${segments.join("/")}`;
  if (normalized !== base && !normalized.startsWith(`${base}/`)) {
    return { path: base, inside: false };
  }
  return { path: normalized, inside: true };
}

/** {@link resolveWithinRoot}, refusing anything that leaves the root. */
export function requireWithinRoot(root: string, path: string): string {
  const resolved = resolveWithinRoot(root, path);
  if (!resolved.inside) throw new FilePathEscapeError(path);
  return resolved.path;
}

/** Whether `path` is the root or sits under it, without normalizing it. */
export function isWithinRoot(root: string, path: string): boolean {
  const base = withoutTrailingSlash(root);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * `path` expressed relative to `root` (`""` for the root itself), or null when
 * it is outside `root`.
 *
 * A zip entry name is this value. which is why it is null rather than a
 * best-effort string: an entry name that had to climb out of the tree with `..`
 * must never be written into an archive.
 */
export function relativeToRoot(root: string, path: string): string | null {
  const base = withoutTrailingSlash(root);
  if (path === base) return "";
  if (!path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1);
}

/** The last segment of a path. the display name of a file or folder. */
export function baseName(path: string): string {
  const base = withoutTrailingSlash(path);
  const index = base.lastIndexOf("/");
  return index === -1 ? base : base.slice(index + 1);
}

/** The parent directory of a path (`/` for a top-level path). */
export function dirName(path: string): string {
  const base = withoutTrailingSlash(path);
  const index = base.lastIndexOf("/");
  return index <= 0 ? "/" : base.slice(0, index);
}

/**
 * Whether a name may be created or renamed to. one segment, nothing clever.
 *
 * A backslash is refused even though Linux allows it in a file name: a client
 * that sends one means a path, and honouring that intent here would be the bug.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}
