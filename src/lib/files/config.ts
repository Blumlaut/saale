/**
 * File browser limits.
 *
 * Every one of these exists because the browser reads through an interface that
 * hands back whole payloads rather than streams: Open Terminal returns a file as
 * one buffer, and a multipart upload is parsed into memory before a single byte
 * is written. Without ceilings, one large folder or one careless "upload the
 * toolchain" would be an out-of-memory kill rather than a clear refusal.
 *
 * Pure data. no Node or database imports. so the client can show the same
 * numbers the server enforces.
 */

/** Rows returned for one directory before the listing is marked truncated. */
export const MAX_LISTING_ENTRIES = 2000;

/** Dotfiles are noise in an agent's workspace (`.git`, caches) until asked for. */
export const HIDE_DOTFILES_DEFAULT = true;

/** Largest single uploaded file. */
export const MAX_UPLOAD_BYTES_PER_FILE = 25 * 1024 * 1024;

/** Files accepted in one upload request. */
export const MAX_UPLOAD_FILES = 20;

/**
 * Largest total upload request.
 *
 * Multipart parsing buffers the whole request, so this is the real memory
 * ceiling. `MAX_UPLOAD_BYTES_PER_FILE × MAX_UPLOAD_FILES` would allow a
 * half-gigabyte body.
 */
export const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;

/** Entries a single zip download may contain, counting into folders. */
export const MAX_ZIP_ENTRIES = 500;

/** Uncompressed bytes a single zip download may contain. */
export const MAX_ZIP_BYTES = 250 * 1024 * 1024;

/**
 * Largest file the inline viewer will render; bigger ones download instead.
 * Monaco tokenizes a few megabytes comfortably, so the cap sits well above
 * any source file an agent writes and below what a base64 blob would drag
 * into the browser.
 */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/**
 * Largest file the API will serve or archive at all.
 *
 * A workspace read returns the whole file as one buffer, so this is a memory
 * ceiling, not a politeness limit: past it the honest answer is a refusal. It
 * also bounds what a zip entry can cost, since entries are read the same way.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
