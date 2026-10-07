import path from "node:path";

// Built from process.cwd() so the bundler can statically scope tracing to
// <root>/uploads. Resolving a bare relative path against process.env at module
// scope makes Turbopack trace the whole project into the standalone output.
const DEFAULT_UPLOADS_DIR = path.join(process.cwd(), "uploads");

/**
 * Absolute uploads root. `UPLOADS_DIR` (a mounted volume in production)
 * overrides the default.
 */
export function getUploadsDir(): string {
  return process.env.UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR;
}
