/**
 * Content types for workspace files.
 *
 * One map, used by both backends and the viewer: Open Terminal guesses a type
 * from the extension as well, but it answers `application/octet-stream` for
 * anything unfamiliar, and an inline preview of a `.ts` file needs to be text.
 */

/** Extension (lowercase, with dot) to media type. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".toml": "text/toml",
  ".ini": "text/plain",
  ".conf": "text/plain",
  ".log": "text/plain",
  ".env": "text/plain",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Extensions the inline viewer renders as an image. */
export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svg",
]);

/** Nothing behind these is worth showing as text. */
export const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".pdf",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".mov",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".so",
  ".dylib",
  ".dll",
  ".class",
  ".jar",
  ".wasm",
  ".sqlite",
  ".db",
  ".bin",
  ".exe",
]);

/** Text types get an explicit UTF-8 charset: without it browsers guess. */
export function withCharset(mimeType: string): string {
  if (mimeType.includes("charset=")) return mimeType;
  if (mimeType.startsWith("text/")) return `${mimeType}; charset=utf-8`;
  if (mimeType === "application/json" || mimeType === "application/xml") {
    return `${mimeType}; charset=utf-8`;
  }
  return mimeType;
}

/**
 * The extension of a file name, lowercased and with its dot, or "".
 *
 * A leading dot names the file rather than typing it: `.gitconfig` is a text
 * file with no extension, not a `gitconfig` file.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Media type for a file name, or `application/octet-stream` when unknown. */
export function mimeTypeForName(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? "application/octet-stream";
}

/**
 * The type to serve a file as.
 *
 * The extension wins over what the workspace reported: Open Terminal answers
 * `octet-stream` for everything it does not recognise, and a `.ts` file served
 * that way downloads instead of previewing.
 */
export function resolveMimeType(name: string, reported?: string | null): string {
  const fromName = mimeTypeForName(name);
  const fallback = reported?.split(";")[0]?.trim() || "";
  return withCharset(fromName === "application/octet-stream" && fallback ? fallback : fromName);
}

/**
 * Types that must never be served as themselves inline.
 *
 * An agent writes files in a workspace, and those bytes come back through this
 * app's own origin: an HTML file or a scripted SVG served as itself would be
 * stored XSS with the viewer's session. Inline, they are text. readable in the
 * code view, inert in a browser. A download keeps the real type, because
 * `attachment` never renders.
 */
export function inlineSafeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const unsafe = new Set([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
  ]);
  return unsafe.has(base) ? "text/plain; charset=utf-8" : mimeType;
}

/**
 * How the viewer should treat a file.
 *
 * Only the extensions that are certainly media or binary are refused: a
 * workspace is prose, code and config, and its unknown names (`.gitconfig`,
 * `Makefile`, `.env.local`) are text. The reader then drops a file whose first
 * megabyte holds a NUL byte, which is what a real binary looks like.
 */
export function previewKindFor(name: string, mimeType: string): "text" | "image" | "binary" {
  const extension = extensionOf(name);

  // SVG is shown as source: an inline SVG document can carry script.
  if (extension === ".svg") return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return "binary";
  return "text";
}
