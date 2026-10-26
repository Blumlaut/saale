import sharp from "sharp";
import { prisma } from "@/lib/db";
import {
  AVATAR_MAX_UPLOAD_BYTES,
  AVATAR_MIME_TYPES,
  AVATAR_SIZE,
  avatarUrl,
} from "@/lib/profile/avatar-config";

/**
 * Profile pictures. One small square per user, stored as WebP in `user_avatar`
 * and served by `/api/profile/avatar/<userId>`. `user.image` carries the URL so
 * every session and user list already has it.
 */

export { AVATAR_SIZE, AVATAR_MAX_UPLOAD_BYTES, avatarUrl } from "@/lib/profile/avatar-config";

const ALLOWED_MIME_TYPES = new Set<string>(AVATAR_MIME_TYPES);

/** Why an upload cannot be used, or null when it can. */
export function validateAvatarUpload(file: File): string | null {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return "Pick an image: PNG, JPEG, WebP, GIF or AVIF";
  }
  if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
    return "That image is larger than 5 MB";
  }
  if (file.size === 0) {
    return "That image is empty";
  }
  return null;
}

export interface ProcessedAvatar {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Re-encode an upload into the one shape we store: a square WebP. `rotate()`
 * applies the EXIF orientation first, so a phone photo is not sideways; `cover`
 * crops off-centre originals instead of squashing them.
 */
export async function processAvatar(input: Buffer): Promise<ProcessedAvatar> {
  const data = await sharp(input)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .webp({ quality: 82 })
    .toBuffer();

  return { data, mimeType: "image/webp", width: AVATAR_SIZE, height: AVATAR_SIZE };
}

/**
 * Store a new picture and point `user.image` at it.
 *
 * Both writes belong together, so they run in one transaction: a row without the
 * URL would be invisible, and a URL without the row would render broken.
 */
export async function saveAvatar(userId: string, upload: Buffer): Promise<string> {
  const processed = await processAvatar(upload);
  // Prisma wants an ArrayBuffer-backed view; a Node Buffer is not one.
  const bytes = new Uint8Array(processed.data);
  const picture = {
    data: bytes,
    mimeType: processed.mimeType,
    size: bytes.byteLength,
    width: processed.width,
    height: processed.height,
  };

  return prisma.$transaction(async (tx) => {
    const avatar = await tx.userAvatar.upsert({
      where: { userId },
      create: { userId, ...picture },
      update: picture,
    });

    const image = avatarUrl(userId, avatar.updatedAt);
    await tx.user.update({ where: { id: userId }, data: { image } });
    return image;
  });
}

/** Drop a user's picture and the URL that points at it. */
export async function removeAvatar(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.userAvatar.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { image: null } }),
  ]);
}

/** The stored bytes, for the serving route. */
export async function readAvatar(
  userId: string,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const avatar = await prisma.userAvatar.findUnique({
    where: { userId },
    select: { data: true, mimeType: true },
  });
  return avatar ?? null;
}
