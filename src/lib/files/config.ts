/**
 * File browser limits.
 *
 * Nothing here bounds a download. a file is streamed to the browser no matter
 * what it weighs, on its own or inside an archive. The one ceiling left on the
 * way out is the inline preview, which the viewer has to hold in memory.
 *
 * Uploads go the other way and are chunked, one small request at a time, so a
 * file's size bounds the volume it lands on rather than the heap.
 *
 * Pure data. no Node or database imports. so the client can show the same
 * numbers the server enforces.
 */

/** Rows returned for one directory before the listing is marked truncated. */
export const MAX_LISTING_ENTRIES = 2000;

/** Dotfiles are noise in an agent's workspace (`.git`, caches) until asked for. */
export const HIDE_DOTFILES_DEFAULT = true;

/** Largest single uploaded file. Bounds the volume, not memory. */
export const MAX_UPLOAD_BYTES_PER_FILE = 2 * 1024 * 1024 * 1024;

/**
 * Bytes per chunk request.
 *
 * A chunk is the only part of an upload that is ever in memory, so it stays
 * small enough to be cheap and well under the request body ceiling next.config
 * sets for the proxy.
 */
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Files accepted in one upload batch. */
export const MAX_UPLOAD_FILES = 20;

/** Entries a single zip download may contain, counting into folders. */
export const MAX_ZIP_ENTRIES = 500;

/**
 * Largest file the inline viewer will render; bigger ones download instead.
 * Monaco tokenizes a few megabytes comfortably, so the cap sits well above
 * any source file an agent writes and below what a base64 blob would drag
 * into the browser.
 */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/**
 * Response header carrying the mtime of the bytes a raw read just served.
 *
 * The editor opens a file from a listing row and saves against this, so a save
 * is checked against the write it actually read. A listing goes stale as soon
 * as anything writes the folder.
 */
export const FILE_MODIFIED_HEADER = "x-file-modified";
