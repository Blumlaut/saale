import type { LucideIcon } from "lucide-react";

/**
 * Slash commands. one command system for every Saale surface.
 *
 * A command is declared once in `catalog.ts` (metadata, safe to import from a
 * client component) and implemented once in `handlers/` (server-only). Each
 * surface renders an interactive command's prompt in its own idiom. the web
 * chat uses a sheet, the Telegram bot an inline keyboard. but both execute
 * the same handler through `executeCommand`.
 */

export type CommandSurface = "web" | "telegram";

/** One choice offered by an interactive command. */
export interface CommandOption {
  value: string;
  label: string;
  description?: string;
  /** The option currently in effect. the surfaces mark it as selected. */
  current?: boolean;
}

/** What an interactive command asks the user before it can run. */
export interface CommandPrompt {
  title: string;
  description?: string;
  options: CommandOption[];
}

/** Toast flavour on web, reply flavour on Telegram. */
export type CommandTone = "success" | "info" | "error";

/** Work the surface must redo once the command has run. */
export type CommandRefresh = "messages" | "generation";

export interface CommandOutcome {
  /** Human-readable result. a toast on web, a reply on Telegram. */
  message: string;
  tone?: CommandTone;
  refresh?: CommandRefresh;
}

/** Command metadata. everything a surface needs to list or offer a command. */
export interface CommandMeta {
  name: string;
  description: string;
  surfaces: readonly CommandSurface[];
  icon: LucideIcon;
}

interface CommandBaseContext {
  userId: string;
  /** Text after the command name, trimmed. "" when the user gave none. */
  args: string;
}

export interface WebCommandContext extends CommandBaseContext {
  surface: "web";
  /** The chat session the command acts on (ownership already checked). */
  sessionId: string;
}

export interface TelegramCommandContext extends CommandBaseContext {
  surface: "telegram";
  telegramChatId: bigint;
  encryptedToken: string;
  /** The user's command message. replies point at it. */
  replyToMessageId?: number | undefined;
}

export type CommandContext = WebCommandContext | TelegramCommandContext;

/**
 * Server-side implementation of a command.
 *
 * `prepare` is present exactly on interactive commands: it builds the prompt
 * whose options the surface renders before calling `run` with the chosen
 * value. Commands without it run straight away.
 */
export interface CommandHandler {
  prepare?: (ctx: CommandContext) => Promise<CommandPrompt>;
  run: (ctx: CommandContext, value?: string) => Promise<CommandOutcome>;
}
