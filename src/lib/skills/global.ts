/**
 * Skills the user installs once and every chat of theirs reads.
 *
 * The workspace is the whole tree a session may read, so an installed skill is
 * a directory there: `.agents/skills/<name>/SKILL.md`. Pi's own rules decide
 * what counts as a usable skill, here and at session build; this module only
 * writes, lists and removes the files, and says why it refused one.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isNotFoundError } from "@/lib/files/errors";
import { requireWithinRoot } from "@/lib/files/paths";
import { userWorkspacePath, writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { fetchUrl } from "@/lib/web/fetch";
import {
  GLOBAL_SKILLS_DIR,
  isSkillName,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_NAME,
  SKILL_NAME_MAX,
  type SkillView,
} from "./shared";

/** Trailing marker `fetchUrl` appends when it cut a body short. */
const TRUNCATION_MARKER = "... [truncated]";

/** Absolute directory of a user's installed skills. */
export function globalSkillsDir(userId: string): string {
  return path.join(userWorkspacePath(userId), GLOBAL_SKILLS_DIR);
}

/**
 * The installed skills the model will be offered.
 *
 * Read through Pi's loader so the list matches the prompt: a file Pi would skip
 * for a missing description is left out here too, and the reason reaches the
 * log rather than the page.
 */
export async function listGlobalSkills(userId: string): Promise<SkillView[]> {
  const root = userWorkspacePath(userId);
  const dir = globalSkillsDir(userId);
  if (!(await isDirectory(dir))) return [];

  const { skills, diagnostics } = loadSkills({
    cwd: root,
    agentDir: root,
    skillPaths: [dir],
    includeDefaults: false,
  });
  for (const diagnostic of diagnostics) {
    const where = diagnostic.path ? ` (${diagnostic.path})` : "";
    console.warn(`Skill not loaded: ${diagnostic.message}${where}`);
  }
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
  }));
}

/** What the settings sheet sends: the file's text, or an address to read it from. */
export interface InstallSkillInput {
  markdown?: string | undefined;
  url?: string | undefined;
}

export type InstallSkillResult =
  { ok: true; skill: SkillView } | { ok: false; error: string; status: number };

/**
 * Write a skill into the user's workspace, replacing one of the same name.
 *
 * The frontmatter is read here rather than left to Pi: a skill that Pi would
 * silently skip looks installed on the page, so the refusal has to come back to
 * whoever pasted it.
 */
export async function installGlobalSkill(
  userId: string,
  input: InstallSkillInput,
): Promise<InstallSkillResult> {
  let markdown = input.markdown?.trim() ?? "";
  if (!markdown && input.url) {
    const fetched = await fetchSkillMarkdown(input.url);
    if (!fetched.ok) return { ok: false, error: fetched.error, status: 502 };
    markdown = fetched.markdown;
  }

  const parsed = parseSkillMarkdown(markdown);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };

  const absolute = await writeWorkspaceFile(
    userId,
    `${GLOBAL_SKILLS_DIR}/${parsed.name}/${SKILL_FILE_NAME}`,
    Buffer.from(markdown),
  );

  return {
    ok: true,
    skill: { name: parsed.name, description: parsed.description, path: absolute },
  };
}

/** Remove an installed skill. `false` means there was nothing by that name. */
export async function removeGlobalSkill(userId: string, name: string): Promise<boolean> {
  if (!isSkillName(name)) return false;
  const absolute = requireWithinRoot(
    globalSkillsDir(userId),
    path.join(globalSkillsDir(userId), name),
  );
  const existed = await isDirectory(absolute);
  await fs.rm(absolute, { recursive: true, force: true });
  return existed;
}

export type ParseSkillResult =
  { ok: true; name: string; description: string } | { ok: false; error: string };

/**
 * Read a `SKILL.md` and report what is wrong with it.
 *
 * The name it returns is the declared one: it becomes the directory, and Pi
 * takes the description from the same frontmatter when it builds the prompt.
 */
export function parseSkillMarkdown(markdown: string): ParseSkillResult {
  if (markdown.trim().length === 0) {
    return { ok: false, error: "Paste the skill's SKILL.md, or give an address to read it from." };
  }
  if (Buffer.byteLength(markdown) > SKILL_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `A SKILL.md is at most ${Math.round(SKILL_FILE_MAX_BYTES / 1024)} KB.`,
    };
  }

  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(markdown);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

  if (!name) {
    return { ok: false, error: "The frontmatter needs a name, e.g. `name: pdf-tools`." };
  }
  if (!isSkillName(name)) {
    return {
      ok: false,
      error: `"${name}" is not a skill name: lowercase letters, digits and single hyphens, up to ${SKILL_NAME_MAX} characters.`,
    };
  }
  if (!description) {
    return {
      ok: false,
      error:
        "The frontmatter needs a description: it is what tells the model when to use the skill.",
    };
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `The description is longer than ${SKILL_DESCRIPTION_MAX} characters.`,
    };
  }
  if (body.trim().length === 0) {
    return { ok: false, error: "The skill has no instructions below its frontmatter." };
  }

  return { ok: true, name, description };
}

type FetchSkillResult = { ok: true; markdown: string } | { ok: false; error: string };

/**
 * Read a skill from an address.
 *
 * `fetchUrl` refuses internal hosts and follows redirects itself; a body that
 * came back cut short is refused rather than installed as a partial skill.
 */
async function fetchSkillMarkdown(address: string): Promise<FetchSkillResult> {
  const result = await fetchUrl({ url: address, format: "raw", maxChars: SKILL_FILE_MAX_BYTES });
  if ("error" in result) return { ok: false, error: `Could not fetch the skill: ${result.error}` };
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return {
      ok: false,
      error: `Could not fetch the skill: the server answered ${result.statusCode}.`,
    };
  }
  if (result.content.includes(TRUNCATION_MARKER)) {
    return {
      ok: false,
      error: `That file is larger than ${Math.round(SKILL_FILE_MAX_BYTES / 1024)} KB.`,
    };
  }
  return { ok: true, markdown: result.content.trim() };
}

async function isDirectory(target: string): Promise<boolean> {
  const stat = await fs.stat(target).catch((err: unknown) => {
    if (isNotFoundError(err)) return null;
    console.error(`Failed to inspect ${target}:`, err);
    return null;
  });
  return stat?.isDirectory() ?? false;
}
