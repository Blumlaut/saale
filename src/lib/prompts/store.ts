/**
 * Persistence for prompts, owned by an account or by the instance.
 *
 * The settings routes write rows, the send paths read them, so validation and
 * scoping live here. The owner picks the table, and the two never mix: a user's
 * prompt carries `userId` on every query, an instance prompt lives in a table
 * with no owner column at all.
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

/** A prompt row, whichever table it came from. */
export type PromptRecord = Omit<Prompt, "userId">;

/** Who owns the prompt rows a call works on. */
export type PromptOwner = { kind: "user"; userId: string } | { kind: "instance" };

/** The instance's prompts: written by an admin, offered to every account. */
export const INSTANCE_PROMPTS: PromptOwner = { kind: "instance" };

/** One account's prompts. */
export function userPrompts(userId: string): PromptOwner {
  return { kind: "user", userId };
}

export interface PromptInput {
  name: string;
  description: string;
  argumentHint: string | null;
  scope: PromptScope;
  content: string;
}

export type PromptValidation = { ok: true; value: PromptInput } | { ok: false; error: string };

export type PromptWrite =
  | { ok: true; prompt: PromptRecord }
  /** `conflict` is a name the owner already uses. */
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
export function serializePrompt(prompt: PromptRecord) {
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

/** The table a prompt owner's rows live in, as the store functions below need it. */
interface PromptStore {
  list(): Promise<PromptRecord[]>;
  findByName(name: string): Promise<PromptRecord | null>;
  findById(id: string): Promise<PromptRecord | null>;
  create(data: PromptInput): Promise<PromptRecord>;
  update(id: string, data: PromptInput): Promise<PromptRecord>;
  remove(id: string): Promise<number>;
}

function storeFor(owner: PromptOwner): PromptStore {
  if (owner.kind === "instance") {
    return {
      list: () => prisma.sharedPrompt.findMany({ orderBy: { name: "asc" } }),
      findByName: (name) => prisma.sharedPrompt.findFirst({ where: { name } }),
      findById: (id) => prisma.sharedPrompt.findFirst({ where: { id } }),
      create: (data) => prisma.sharedPrompt.create({ data }),
      update: (id, data) => prisma.sharedPrompt.update({ where: { id }, data }),
      remove: async (id) => (await prisma.sharedPrompt.deleteMany({ where: { id } })).count,
    };
  }

  const { userId } = owner;
  return {
    list: () => prisma.prompt.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    findByName: (name) => prisma.prompt.findFirst({ where: { userId, name } }),
    findById: (id) => prisma.prompt.findFirst({ where: { id, userId } }),
    create: (data) => prisma.prompt.create({ data: { userId, ...data } }),
    update: (id, data) => prisma.prompt.update({ where: { id, userId }, data }),
    remove: async (id) => (await prisma.prompt.deleteMany({ where: { id, userId } })).count,
  };
}

function conflictMessage(owner: PromptOwner, name: string): string {
  return owner.kind === "instance"
    ? `The instance already has a prompt named /${name}.`
    : `You already have a prompt named /${name}.`;
}

/** Every prompt the owner has, by name. */
export async function listPrompts(owner: PromptOwner): Promise<PromptRecord[]> {
  return storeFor(owner).list();
}

/** Find a prompt by name, or null when the owner has none of that name. */
export async function findPromptByName(
  owner: PromptOwner,
  name: string,
): Promise<PromptRecord | null> {
  return storeFor(owner).findByName(name.toLowerCase());
}

export async function createPrompt(owner: PromptOwner, input: PromptInput): Promise<PromptWrite> {
  const store = storeFor(owner);
  const taken = await store.findByName(input.name);
  if (taken) return { ok: false, error: conflictMessage(owner, input.name), conflict: true };

  try {
    return { ok: true, prompt: await store.create(input) };
  } catch (err) {
    return raceOrThrow(owner, err, input);
  }
}

export async function updatePrompt(
  owner: PromptOwner,
  id: string,
  input: PromptInput,
): Promise<PromptWrite | null> {
  const store = storeFor(owner);
  const existing = await store.findById(id);
  if (!existing) return null;

  const taken = await store.findByName(input.name);
  if (taken && taken.id !== id) {
    return { ok: false, error: conflictMessage(owner, input.name), conflict: true };
  }

  try {
    return { ok: true, prompt: await store.update(id, input) };
  } catch (err) {
    return raceOrThrow(owner, err, input);
  }
}

/** Delete a prompt the owner has. Returns false when nothing matched. */
export async function deletePrompt(owner: PromptOwner, id: string): Promise<boolean> {
  return (await storeFor(owner).remove(id)) > 0;
}

/** A name claimed between the check and the write is the same conflict. */
function raceOrThrow(owner: PromptOwner, err: unknown, input: PromptInput): PromptWrite {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002") {
    return { ok: false, error: conflictMessage(owner, input.name), conflict: true };
  }
  throw err;
}
