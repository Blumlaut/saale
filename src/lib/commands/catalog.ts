import { Bot, ShieldCheck, Sparkles, Square } from "lucide-react";
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
    name: "compact",
    description: "Summarise this conversation to free up context",
    surfaces: ["web", "telegram"],
    icon: Sparkles,
  },
  {
    name: "model",
    description: "Choose the model this chat answers with",
    surfaces: ["web", "telegram"],
    icon: Bot,
  },
  {
    name: "stfu",
    description: "Auto-accept tool approvals for 2 hours",
    surfaces: ["web", "telegram"],
    icon: ShieldCheck,
  },
  {
    name: "stop",
    description: "Stop the response that is running now",
    surfaces: ["web", "telegram"],
    icon: Square,
  },
] as const satisfies readonly CommandMeta[];

export type CommandName = (typeof COMMAND_CATALOG)[number]["name"];

const BY_NAME = new Map<string, CommandMeta>(COMMAND_CATALOG.map((meta) => [meta.name, meta]));

/** Look up a command by name, case-insensitively. */
export function getCommandMeta(name: string): CommandMeta | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** Commands offered on a surface, in catalog order. */
export function listCommands(surface: CommandSurface): readonly CommandMeta[] {
  return COMMAND_CATALOG.filter((meta) => meta.surfaces.includes(surface));
}

/**
 * Commands a surface offers that match a `/`-prefixed query.
 * Name matches rank above description matches; catalog order within each.
 */
export function searchCommands(surface: CommandSurface, query: string): readonly CommandMeta[] {
  const wanted = query.trim().toLowerCase();
  const available = listCommands(surface);
  if (!wanted) return available;

  const byName = available.filter((meta) => meta.name.startsWith(wanted));
  const byDescription = available.filter(
    (meta) => !meta.name.startsWith(wanted) && meta.description.toLowerCase().includes(wanted),
  );
  return [...byName, ...byDescription];
}
