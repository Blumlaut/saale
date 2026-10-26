/**
 * The agent avatar an admin uploads, stored under `<uploads>/branding`.
 *
 * One file at a time: a new upload gets a fresh name and the previous file is
 * removed, so the name doubles as the cache version. The name is the only thing
 * kept in the database, and it is checked against the pattern we generate
 * before it is ever joined onto a path.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { isBrandingAvatarName } from "@/lib/branding/avatar-name";
import { getUploadsDir } from "@/lib/uploads";

/** Square edge of the stored avatar, enough for the mark at 2x everywhere. */
const AVATAR_SIZE = 256;

/** Uploads above this are refused before decoding. */
export const AVATAR_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** The folder avatars live in. */
function avatarDir(): string {
  return path.join(getUploadsDir(), "branding");
}

/** Absolute path for a stored avatar, or `null` for a name we did not write. */
function avatarPath(fileName: string): string | null {
  if (!isBrandingAvatarName(fileName)) return null;
  return path.join(avatarDir(), fileName);
}

/** Why an upload was refused, or `null` when it is fine. */
export function validateAvatarUpload(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return `Unsupported image type: ${file.type || "unknown"}`;
  }
  if (file.size === 0) return "The image is empty";
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
    const limit = (AVATAR_MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0);
    return `The image is larger than ${limit}MB`;
  }
  return null;
}

/** Decode, square-crop and store an uploaded image. Returns the stored name. */
export async function storeBrandingAvatar(buffer: Buffer): Promise<string> {
  const fileName = `avatar-${randomUUID()}.png`;
  const directory = avatarDir();
  await fs.mkdir(directory, { recursive: true });

  // `attention` crops around the busiest region, which is a face far more often
  // than the centre of a photo is.
  const image = await sharp(buffer)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
    .png({ compressionLevel: 9 })
    .toBuffer();

  await fs.writeFile(path.join(directory, fileName), image);
  return fileName;
}

/** Delete a stored avatar. A name we did not write is ignored. */
export async function removeBrandingAvatar(fileName: string): Promise<void> {
  const filePath = avatarPath(fileName);
  if (!filePath) return;
  await fs.rm(filePath, { force: true });
}

/** The stored avatar bytes, or `null` when the name is one we did not write. */
export async function readBrandingAvatar(fileName: string): Promise<Buffer | null> {
  const filePath = avatarPath(fileName);
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    // A row pointing at a deleted file is a missing avatar, not a failure.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
