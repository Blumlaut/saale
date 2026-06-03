import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

// Max dimension for re-encoded images (keeps token costs reasonable for vision models)
const MAX_DIMENSION = 2048;
// WebP quality (0-100); 80 is a good balance of quality vs file size
const WEBP_QUALITY = 80;
// Max upload size: 15MB
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Allowed input MIME types for image uploads */
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
]);

/**
 * Generate a user-scoped directory for image attachments.
 */
function getUserImageDir(userId: string): string {
  return path.join(UPLOADS_DIR, userId, "images");
}

/**
 * Validate that an uploaded file is an allowed image type and within size limits.
 */
export function validateImageUpload(file: File): string | null {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return `Unsupported file type: ${file.type}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB`;
  }
  if (file.size === 0) {
    return "File is empty";
  }
  return null;
}

/**
 * Re-encode an image buffer to WebP and save to the user's image directory.
 *
 * - Resizes to fit within MAX_DIMENSION while preserving aspect ratio
 * - Converts to WebP with alpha channel support (quality 80)
 * - Returns metadata about the stored file
 */
export async function processAndStoreImage(
  userId: string,
  fileBuffer: Buffer,
  _originalName: string,
  _originalMimeType: string,
  _originalSize: number,
): Promise<{
  storageId: string;
  storagePath: string;
  width: number;
  height: number;
}> {
  const imageDir = getUserImageDir(userId);
  await fs.mkdir(imageDir, { recursive: true });

  const storageId = randomUUID();
  const storagePath = `images/${storageId}.webp`;
  const fullPath = path.join(UPLOADS_DIR, userId, storagePath);

  // Process with sharp: resize, convert to WebP
  const metadata = await sharp(fileBuffer)
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toFile(fullPath);

  return {
    storageId,
    storagePath,
    width: metadata.width,
    height: metadata.height,
  };
}

/**
 * Read an image from disk and return as a base64-encoded string.
 */
export async function readImageAsBase64(
  userId: string,
  storagePath: string,
): Promise<{ data: string; mimeType: string }> {
  const fullPath = path.join(UPLOADS_DIR, userId, storagePath);
  const buffer = await fs.readFile(fullPath);
  return {
    data: buffer.toString("base64"),
    mimeType: "image/webp",
  };
}

/**
 * Resolve the full filesystem path for a stored image.
 */
export function resolveImagePath(userId: string, storagePath: string): string {
  return path.join(UPLOADS_DIR, userId, storagePath);
}
