import { Bot, Image, MessageSquarePlus, ShieldCheck, Sparkles, Square, Wand2 } from "lucide-react";
import type { CommandMeta, CommandSurface } from "./types";

/**
 * Every slash command, declared once.
 *
 * The web composer's `/` menu, the Telegram bot menu (`setMyCommands`) and the
 * executor all read this list, so a surface can never offer a command the
 * others don't know about. `handlers/index.ts` maps each name to its
 * implementation; the map is typed over this catalog, so a command declared
 * without a handler (or a handler for a command that no longer exists) fails
 * typecheck.
 */
export const COMMAND_CATALOG = [
  {
    name: "new",
    // The web starts a chat with a button; on Telegram this is the only way to.
    description: "Start a new chat",
    surfaces: ["telegram"],
    icon: MessageSquarePlus,
  },
  {
    name: "compact",
    description: "Summarise this conversation to free up context",
    progress: "Summarising the conversation…",
    surfaces: ["web", "telegram"],
    icon: Sparkles,
  },
  {
    name: "model",
    description: "Choose the model this chat answers with",
    surfaces: ["web", "telegram"],
    icon: Bot,
    arguments: [
      {
        name: "name",
        kind: "choice",
        description: "The model to switch to",
      },
    ],
  },
  {
    name: "image",
    description: "Render a picture from a prompt, without the agent",
    surfaces: ["web"],
    icon: Image,
    arguments: [
      { name: "prompt", kind: "text", required: true, description: "What to render" },
      {
        name: "size",
        kind: "choice",
        description: "Resolution, out of the ones the model renders at",
      },
    ],
  },
  {
    name: "edit",
    description: "Change a picture you attach, or combine several, without the agent",
    surfaces: ["web"],
    icon: Wand2,
    arguments: [
      {
        name: "prompt",
        kind: "text",
        required: true,
        description: "What to change, and what to keep",
      },
      {
        name: "files",
        kind: "files",
        required: true,
        description: "The pictures to work from",
      },
      {
        name: "size",
        kind: "choice",
        description: "Resolution, out of the ones the model renders at",
      },
    ],
  },
  {
    name: "stfu",
    aliases: ["yolo"],
    description: "Auto-accept tool approvals for 2 hours or permanently",
    surfaces: ["web", "telegram"],
    icon: ShieldCheck,
    arguments: [
      {
        name: "time",
        kind: "choice",
        description: "On for 2 hours, permanent, or off",
        choices: [
          { value: "on", label: "Auto-accept for 2 hours" },
          { value: "permanent", label: "Stay on until I turn it off" },
          { value: "stop", label: "Turn it off" },
        ],
      },
    ],
  },
  {
    name: "stop",
    description: "Stop the response that is running now",
    surfaces: ["web", "telegram"],
    icon: Square,
    arguments: [
      {
        name: "clear",
        kind: "boolean",
        description: "Drop the messages waiting in the queue too",
      },
    ],
  },
] as const satisfies readonly CommandMeta[];

export type CommandName = (typeof COMMAND_CATALOG)[number]["name"];

const BY_NAME = new Map<string, CommandMeta>(COMMAND_CATALOG.map((meta) => [meta.name, meta]));

const BY_ALIAS = new Map<string, CommandName>(
  COMMAND_CATALOG.flatMap((meta) =>
    ("aliases" in meta ? meta.aliases : []).map((alias) => [alias, meta.name] as const),
  ),
);

/** Look up a command by name or alias, case-insensitively. */
export function getCommandMeta(name: string): CommandMeta | undefined {
  const wanted = name.toLowerCase();
  return BY_NAME.get(BY_ALIAS.get(wanted) ?? wanted);
}

/** Commands offered on a surface, in catalog order. */
export function listCommands(surface: CommandSurface): readonly CommandMeta[] {
  return COMMAND_CATALOG.filter((meta) =>
    (meta.surfaces as readonly CommandSurface[]).includes(surface),
  );
}

/**
 * Commands a surface offers that match a `/`-prefixed query.
 * Name and alias matches rank above description matches; catalog order within each.
 */
export function searchCommands(surface: CommandSurface, query: string): readonly CommandMeta[] {
  const wanted = query.trim().toLowerCase();
  const available = listCommands(surface);
  if (!wanted) return available;

  const byName = available.filter((meta) => matchesName(meta, wanted));
  const byDescription = available.filter(
    (meta) => !matchesName(meta, wanted) && meta.description.toLowerCase().includes(wanted),
  );
  return [...byName, ...byDescription];
}

function matchesName(meta: CommandMeta, wanted: string): boolean {
  const names = [meta.name, ...(meta.aliases ?? [])];
  return names.some((name) => name.startsWith(wanted));
}
