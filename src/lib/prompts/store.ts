/**
 * Persistence for a user's prompts.
 *
 * The settings routes write rows, the send paths read them, so validation and
 * scoping live here. Every read and write carries `userId`.
 */

import type { Prompt } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  PROMPT_ARGUMENT_HINT_MAX,
  PROMPT_CONTENT_MAX,
  PROMPT_DESCRIPTION_MAX,
  isPromptName,
  isPromptScope,
  isReservedPromptName,
  type PromptScope,
} from "./rules";

export interface PromptInput {
  name: string;
  description: string;
  argumentHint: string | null;
  scope: PromptScope;
  content: string;
}

export type PromptValidation = { ok: true; value: PromptInput } | { ok: false; error: string };

export type PromptWrite =
  | { ok: true; prompt: Prompt }
  /** `conflict` is a name the user already uses. */
  | { ok: false; error: string; conflict?: boolean };

/** Validate a create or update body. Names are case-folded, as the parser does. */
export function normalizePromptInput(input: unknown): PromptValidation {
  const body = (input ?? {}) as Record<string, unknown>;

  if (typeof body.name !== "string" || typeof body.content !== "string") {
    return { ok: false, error: "A name and a prompt are required." };
  }

  const name = body.name.trim().toLowerCase();
  if (!isPromptName(name)) {
    return {
      ok: false,
      error: "The name may only hold lowercase letters, digits, dashes and underscores.",
    };
  }
  if (isReservedPromptName(name)) {
    return { ok: false, error: `/${name} is a built-in command. Pick another name.` };
  }

  const content = body.content.trim();
  if (!content) return { ok: false, error: "The prompt is empty." };
  if (content.length > PROMPT_CONTENT_MAX) {
    return { ok: false, error: `The prompt is longer than ${PROMPT_CONTENT_MAX} characters.` };
  }

  const description = (typeof body.description === "string" ? body.description : "").trim();
  if (!description) return { ok: false, error: "A description is required." };
  if (description.length > PROMPT_DESCRIPTION_MAX) {
    return { ok: false, error: `Keep the description under ${PROMPT_DESCRIPTION_MAX} characters.` };
  }

  const rawHint = typeof body.argumentHint === "string" ? body.argumentHint.trim() : "";
  if (rawHint.length > PROMPT_ARGUMENT_HINT_MAX) {
    return {
      ok: false,
      error: `Keep the argument hint under ${PROMPT_ARGUMENT_HINT_MAX} characters.`,
    };
  }

  const scope = body.scope ?? "any";
  if (!isPromptScope(scope)) return { ok: false, error: "Unknown scope." };

  return {
    ok: true,
    value: { name, description, argumentHint: rawHint || null, scope, content },
  };
}

/** The shape a prompt takes on the wire. */
export function serializePrompt(prompt: Prompt) {
  return {
    id: prompt.id,
    name: prompt.name,
    description: prompt.description,
    argumentHint: prompt.argumentHint,
    scope: prompt.scope as PromptScope,
    content: prompt.content,
    updatedAt: prompt.updatedAt.toISOString(),
  };
}

/** Every prompt the user owns, by name. */
export async function listUserPrompts(userId: string): Promise<Prompt[]> {
  return prisma.prompt.findMany({ where: { userId }, orderBy: { name: "asc" } });
}

/** Find a prompt by name, or null when the user has none of that name. */
export async function findUserPrompt(userId: string, name: string): Promise<Prompt | null> {
  return prisma.prompt.findFirst({ where: { userId, name: name.toLowerCase() } });
}

export async function createPrompt(userId: string, input: PromptInput): Promise<PromptWrite> {
  const taken = await findUserPrompt(userId, input.name);
  if (taken)
    return { ok: false, error: `You already have a prompt named /${input.name}.`, conflict: true };

  try {
    const prompt = await prisma.prompt.create({ data: { userId, ...input } });
    return { ok: true, prompt };
  } catch (err) {
    return raceOrThrow(err, input);
  }
}

export async function updatePrompt(
  userId: string,
  id: string,
  input: PromptInput,
): Promise<PromptWrite | null> {
  const existing = await prisma.prompt.findFirst({ where: { id, userId } });
  if (!existing) return null;

  const taken = await findUserPrompt(userId, input.name);
  if (taken && taken.id !== id) {
    return { ok: false, error: `You already have a prompt named /${input.name}.`, conflict: true };
  }

  try {
    const prompt = await prisma.prompt.update({ where: { id, userId }, data: input });
    return { ok: true, prompt };
  } catch (err) {
    return raceOrThrow(err, input);
  }
}

/** Delete a prompt the user owns. Returns false when nothing matched. */
export async function deletePrompt(userId: string, id: string): Promise<boolean> {
  const result = await prisma.prompt.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** A name claimed between the check and the write is the same conflict. */
function raceOrThrow(err: unknown, input: PromptInput): PromptWrite {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002") {
    return { ok: false, error: `You already have a prompt named /${input.name}.`, conflict: true };
  }
  throw err;
}
