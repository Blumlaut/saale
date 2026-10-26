/**
 * The only file name shape the avatar store writes. Kept apart from
 * `avatar.ts` so the settings registry can validate a name without pulling
 * `sharp` into every process that reads a setting.
 */

const AVATAR_NAME_PATTERN =
  /^avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

/** Whether a stored name is one this app generated. */
export function isBrandingAvatarName(value: string): boolean {
  return AVATAR_NAME_PATTERN.test(value);
}
