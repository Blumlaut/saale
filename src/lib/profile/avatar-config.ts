/**
 * Avatar limits and URL shape. Kept apart from the storage module so the profile
 * form can render them: that one imports `sharp` and Prisma, which a client
 * component cannot.
 */

/** Edge length of the stored picture. Sharp at the 40-96 css px it is drawn at. */
export const AVATAR_SIZE = 96;

/** Refused before decoding: a picture this large is a mistake, not a photo. */
export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Image types the upload route accepts. */
export const AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/** The URL a stored picture is served from. `version` busts the browser cache. */
export function avatarUrl(userId: string, version: Date | number): string {
  const stamp = version instanceof Date ? version.getTime() : version;
  return `/api/profile/avatar/${userId}?v=${stamp}`;
}
