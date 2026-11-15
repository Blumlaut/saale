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

/**
 * How a command takes a value.
 *
 * - `text`  . free text, written `name:value` and running to the end of the line.
 * - `choice`. one of the options its prompt offers, or one of `choices`.
 * - `files` . pictures the composer attached, which a command cannot parse out
 *             of the line at all.
 */
export type CommandArgumentKind = "text" | "choice" | "files";

/** One argument a command accepts, as the composer offers and the parser reads it. */
export interface CommandArgument {
  /** Written before the colon: `/image prompt:a red fox`. */
  name: string;
  kind: CommandArgumentKind;
  description: string;
  required?: boolean;
  /** Static options, for a choice the surfaces can offer without asking the server. */
  choices?: readonly string[];
}

/** A file the composer attached to a command, adopted into the workspace. */
export interface CommandFile {
  /** Absolute path in the agent workspace. */
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
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
  /** Extra names the same command answers to. surfaces never list these. */
  aliases?: readonly string[];
  description: string;
  /**
   * What a surface says while the command runs. Only for a command that takes
   * long enough that a silent composer reads as a dropped request.
   */
  progress?: string;
  surfaces: readonly CommandSurface[];
  icon: LucideIcon;
  /** What the command accepts after its name. Absent when it takes nothing. */
  arguments?: readonly CommandArgument[];
}

interface CommandBaseContext {
  userId: string;
  /** Text after the command name, trimmed. "" when the user gave none. */
  args: string;
  /** Files the composer pointed at the command. Empty when it took none. */
  files: readonly CommandFile[];
}

export interface WebCommandRequest extends CommandBaseContext {
  surface: "web";
  /** The chat session the command acts on (ownership already checked). */
  sessionId: string;
}

export interface TelegramCommandRequest extends CommandBaseContext {
  surface: "telegram";
  /** The chat this command acts on. Absent when there is no conversation yet. */
  sessionId?: string | undefined;
  telegramChatId: bigint;
  encryptedToken: string;
  /** The user's command message. replies point at it. */
  replyToMessageId?: number | undefined;
}

/** What a surface hands `executeCommand`. the line, and the files it attached. */
export type CommandRequest = WebCommandRequest | TelegramCommandRequest;

/** What a handler gets: the request, plus the arguments parsed out of its line. */
export type CommandContext = CommandRequest & {
  arguments: Readonly<Record<string, string>>;
};

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
