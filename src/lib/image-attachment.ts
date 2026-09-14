import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

// Max dimension for re-encoded images (keeps token costs reasonable for vision models)
const MAX_DIMENSION = 2048;
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
  const storagePath = `images/${storageId}.png`;
  const fullPath = path.join(UPLOADS_DIR, userId, storagePath);

  // Process with sharp: auto-orient, resize, convert to PNG.
  // autoOrient() bakes the EXIF orientation into the pixels — phone photos
  // store landscape pixels plus a rotation tag, and PNG cannot carry that
  // tag, so without this the LLM sees vertical photos lying on their side.
  const metadata = await sharp(fileBuffer)
    .autoOrient()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
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
    mimeType: "image/png",
  };
}

/**
 * Resolve the full filesystem path for a stored image.
 */
export function resolveImagePath(userId: string, storagePath: string): string {
  return path.join(UPLOADS_DIR, userId, storagePath);
}

/**
 * Delete an image file from disk.
 * Silently ignores missing files.
 */
export async function deleteImage(userId: string, storagePath: string): Promise<void> {
  const fullPath = resolveImagePath(userId, storagePath);
  try {
    await fs.unlink(fullPath);
  } catch {
    // File already gone — nothing to do
  }
}

/**
 * Delete multiple image files atomically.
 *
 * - Deletes all files in parallel
 * - If ANY deletion fails, an error is thrown (files already deleted are gone,
 *   remaining files and DB records stay intact for a clean retry)
 * - Files already missing are treated as success
 *
 * Call this BEFORE the DB delete so the operation fails fast if disk I/O is broken.
 */
export async function deleteAllImages(userId: string, storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;

  const results = await Promise.allSettled(
    storagePaths.map(async (storagePath) => {
      const fullPath = resolveImagePath(userId, storagePath);
      try {
        await fs.unlink(fullPath);
      } catch (err) {
        // File already gone — treat as success
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return;
        }
        throw err;
      }
    }),
  );

  const failures = results
    .map((result, index) =>
      result.status === "rejected"
        ? { storagePath: storagePaths[index]!, error: result.reason }
        : null,
    )
    .filter(Boolean) as Array<{ storagePath: string; error: unknown }>;

  if (failures.length > 0) {
    const details = failures
      .map(
        (f) => `${f.storagePath}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
      )
      .join("; ");
    throw new Error(
      `Failed to delete ${failures.length}/${storagePaths.length} image(s): ${details}`,
    );
  }
}

/**
 * Scan the uploads directory for orphaned image files.
 *
 * An orphan is a file on disk whose storagePath does not appear in any
 * ChatAttachment record. These can arise from server crashes mid-deletion.
 *
 * @returns The number of orphaned files deleted.
 */
export async function cleanupOrphanedImages(): Promise<number> {
  const knownPaths = await getKnownStoragePaths();
  let deletedCount = 0;

  try {
    const entries = await readUserDirs();
    for (const { filePath, relativePath } of entries) {
      if (!knownPaths.has(relativePath)) {
        try {
          await fs.unlink(filePath);
          deletedCount++;
        } catch {
          // File disappeared between scan and delete — fine
        }
      }
    }
  } catch {
    // Uploads dir doesn't exist yet — nothing to clean
  }

  return deletedCount;
}

/**
 * Collect all storage paths from the ChatAttachment table.
 */
async function getKnownStoragePaths(): Promise<Set<string>> {
  const { prisma } = await import("@/lib/db");
  const attachments = await prisma.chatAttachment.findMany({
    select: { storagePath: true },
  });
  return new Set(attachments.map((a) => a.storagePath));
}

/**
 * Walk the uploads directory and yield every image file found.
 */
async function readUserDirs(): Promise<
  Array<{ userId: string; filePath: string; relativePath: string }>
> {
  const entries: Array<{ userId: string; filePath: string; relativePath: string }> = [];

  try {
    const userNames = await fs.readdir(UPLOADS_DIR);
    for (const userName of userNames) {
      const imageDir = path.join(UPLOADS_DIR, userName, "images");
      try {
        const files = await fs.readdir(imageDir);
        for (const file of files) {
          if (!file.endsWith(".png")) continue;
          const relativePath = `images/${file}`;
          entries.push({
            userId: userName,
            filePath: path.join(imageDir, file),
            relativePath,
          });
        }
      } catch {
        // images/ subdirectory doesn't exist for this user — skip
      }
    }
  } catch {
    // Uploads dir doesn't exist — return empty
  }

  return entries;
}
