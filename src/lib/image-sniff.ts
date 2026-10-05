/**
 * Image MIME detection from raw bytes.
 *
 * Pi detects images by sniffing the first bytes of a file, but its
 * `detectSupportedImageMimeTypeFromFile` takes a *path* and reads it with
 * `node:fs`. Backends that do not have the bytes on the local filesystem —
 * Open Terminal containers, remote machines over SFTP — read the header
 * themselves and pass it here instead.
 */

/**
 * Bytes to sniff. Matches Pi's own `IMAGE_TYPE_SNIFF_BYTES`, so a header read
 * is enough for every format it recognises.
 */
export const IMAGE_SNIFF_BYTES = 4100;

/**
 * Detect image MIME type by reading magic bytes from a buffer.
 * Matches Pi's internal detectSupportedImageMimeTypeFromFile behavior.
 */
export function detectImageMimeTypeFromBuffer(data: Buffer): string | null {
  // JPEG: FF D8 FF (skip FF D8 FF F7 special variant)
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return data[3] === 0xf7 ? null : "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A + valid IHDR chunk
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 16 && PNG_SIG.every((b, i) => (data[i] ?? 0) === b)) {
    const chunkLen =
      ((data[8] ?? 0) << 24) | ((data[9] ?? 0) << 16) | ((data[10] ?? 0) << 8) | (data[11] ?? 0);
    if (
      chunkLen === 13 &&
      (data[12] ?? 0) === 0x49 &&
      (data[13] ?? 0) === 0x48 &&
      (data[14] ?? 0) === 0x44 &&
      (data[15] ?? 0) === 0x52
    ) {
      return "image/png";
    }
    return null;
  }

  // GIF: starts with ASCII "GIF"
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return "image/gif";
  }

  // WebP: "RIFF" then "WEBP" at offset 8
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}
