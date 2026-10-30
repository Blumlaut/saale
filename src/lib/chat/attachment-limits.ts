/**
 * What a chat attachment may be.
 *
 * Pure data, so the composer can refuse a file before shipping a byte of it
 * while the server enforces the same numbers.
 */

/** Largest image attachment. Images are re-encoded in memory, so this stays small. */
export const MAX_CHAT_IMAGE_BYTES = 15 * 1024 * 1024;

/** Largest non-image attachment. These are moved, never buffered. */
export const MAX_CHAT_FILE_BYTES = 250 * 1024 * 1024;

/** Files one message may carry. */
export const MAX_CHAT_ATTACHMENTS = 20;

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}
