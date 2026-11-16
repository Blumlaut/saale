/**
 * What a global skill is, for both sides of the settings page.
 *
 * A skill is a directory holding a `SKILL.md`, in the Agent Skills format Pi
 * reads. The user's own skills live in their workspace so the file the model
 * loads sits where its read tool reaches: nothing here needs a database row,
 * and a skill added by hand in the file browser shows up like an installed one.
 */

/** Installed skills live here, relative to the workspace root. */
export const GLOBAL_SKILLS_DIR = ".agents/skills";

/** The file that makes a directory a skill. */
export const SKILL_FILE_NAME = "SKILL.md";

/** Pi's limit on a skill name, from the Agent Skills specification. */
export const SKILL_NAME_MAX = 64;

/** Pi's limit on a skill description. */
export const SKILL_DESCRIPTION_MAX = 1024;

/** A `SKILL.md` above this is refused: it is prompt text, not an attachment. */
export const SKILL_FILE_MAX_BYTES = 128 * 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a name is one Pi accepts: lowercase, digits, single hyphens. */
export function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= SKILL_NAME_MAX && SKILL_NAME_PATTERN.test(value);
}

/** A skill as the settings page lists it: what the model is offered. */
export interface SkillView {
  name: string;
  description: string;
  /** Absolute path of its `SKILL.md`, inside the user's workspace. */
  path: string;
}
