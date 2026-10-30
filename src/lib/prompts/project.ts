/**
 * A project's own prompt templates, in Pi's convention.
 *
 * Pi reads `<cwd>/.pi/prompts/*.md`, and a coder chat works in its worktree, so
 * a project's committed templates reach every coder chat of that project. They
 * are read here rather than handed to Pi because the composer lists them before
 * any agent exists.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { resolveCoderPath, worktreePath } from "@/lib/coder/paths";
import { isNotFoundError } from "@/lib/files/errors";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { PROMPT_ARGUMENT_HINT_MAX, PROMPT_DESCRIPTION_MAX, isPromptName } from "./rules";
import type { PromptEntry } from "./resolve";

/** The chat whose templates these are. */
export interface PromptChat {
  id: string;
  projectId: string | null;
}

/**
 * The directory whose `.pi/prompts` serves this chat: a coder chat's worktree,
 * or the workspace root of an ordinary chat.
 */
export async function chatPromptDirectory(
  userId: string,
  chatSession: PromptChat,
): Promise<string | null> {
  if (!chatSession.projectId) return userWorkspacePath(userId);

  const project = await prisma.coderProject.findFirst({
    where: { id: chatSession.projectId, userId },
    select: { slug: true },
  });
  if (!project) return null;

  try {
    // Derived, not read from `CoderWorktree`: the first message is expanded
    // before the worktree row exists.
    return resolveCoderPath(userId, worktreePath(project.slug, chatSession.id));
  } catch (err) {
    console.error(`Failed to resolve the prompt directory of chat ${chatSession.id}:`, err);
    return null;
  }
}

/**
 * The `.md` children of a directory's `.pi/prompts`, read fresh every time so a
 * template the agent writes mid-chat is offered on the next message.
 */
export async function readProjectPrompts(cwd: string | null): Promise<PromptEntry[]> {
  if (!cwd) return [];
  const dir = path.join(cwd, CONFIG_DIR_NAME, "prompts");

  let names: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((e) => e.name);
  } catch (err) {
    if (!isNotFoundError(err)) console.error(`Failed to read prompt templates in ${dir}:`, err);
    return [];
  }

  const prompts: PromptEntry[] = [];
  for (const fileName of names) {
    const name = fileName.slice(0, -".md".length);
    if (!isPromptName(name)) continue;
    const prompt = await readPromptFile(path.join(dir, fileName), name);
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

/** One template, with Pi's frontmatter fields and its description fallback. */
async function readPromptFile(filePath: string, name: string): Promise<PromptEntry | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);

    const hint = frontmatter["argument-hint"];
    const description = describe(frontmatter.description, body);
    return {
      name,
      description,
      argumentHint: typeof hint === "string" ? hint.slice(0, PROMPT_ARGUMENT_HINT_MAX) : null,
      content: body.trim(),
      source: "project",
    };
  } catch (err) {
    console.error(`Failed to read the prompt template ${filePath}:`, err);
    return null;
  }
}

/** The frontmatter's description, or the template's first line, as a one-liner. */
function describe(frontmatterDescription: unknown, body: string): string {
  const given = typeof frontmatterDescription === "string" ? frontmatterDescription.trim() : "";
  const text =
    given ||
    body
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ||
    "";
  return text.length > PROMPT_DESCRIPTION_MAX
    ? `${text.slice(0, PROMPT_DESCRIPTION_MAX - 1)}…`
    : text;
}
