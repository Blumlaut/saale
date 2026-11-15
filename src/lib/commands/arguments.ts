/**
 * Command arguments, Discord-style: `name:value`.
 *
 * A command declares what it takes, so the same string means the same thing on
 * every surface: the composer offers the names as you type, the parser turns
 * them into named values, and a command that never leaves the server (the
 * Telegram bot) keeps working with plain positional text.
 *
 * Pure data in, pure data out. the composer and the server share these.
 */

import type { CommandArgument, CommandMeta } from "./types";

export interface ParsedCommandArguments {
  /** Values keyed by the argument name, in the order they were written. */
  values: Record<string, string>;
  /** The text outside any `name:` segment, trimmed and collapsed. */
  rest: string;
}

/**
 * Every argument a command can read from the line.
 *
 * `files` come from the composer's file picker, so they are never spelled out.
 */
export function spelledArguments(meta: CommandMeta): readonly CommandArgument[] {
  return (meta.arguments ?? []).filter((arg) => arg.kind !== "files");
}

/** Whether the command takes files at all. */
export function takesFiles(meta: CommandMeta): boolean {
  return (meta.arguments ?? []).some((arg) => arg.kind === "files");
}

/**
 * Read `name:value` pairs out of an argument line.
 *
 * A value runs to the next declared name, so a prompt may hold spaces without
 * quotes: `/image prompt:a red fox size:1536x1024`. Text that names no argument
 * is handed back as `rest`, which keeps the positional forms (`/image a red
 * fox`, `/stfu stop`) working.
 */
export function parseCommandArguments(
  args: string,
  declared: readonly CommandArgument[] = [],
): ParsedCommandArguments {
  const text = args.trim();
  const names = declared.filter((arg) => arg.kind !== "files").map((arg) => arg.name);
  if (!text || names.length === 0) return { values: {}, rest: text };

  const pattern = labelPattern(names);
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return { values: {}, rest: text };

  const values: Record<string, string> = {};
  let rest = "";
  let cursor = 0;

  matches.forEach((match, index) => {
    const name = match[2]!;
    const valueStart = match.index + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? text.length;

    rest += text.slice(cursor, match.index);
    cursor = valueEnd;

    // A repeated name keeps the first value. the second reads as stray text.
    if (name in values) return;
    const value = stripQuotes(text.slice(valueStart, valueEnd).trim());
    if (value) values[name] = value;
  });

  rest += text.slice(cursor);
  return { values, rest: rest.replace(/\s+/g, " ").trim() };
}

/** `(^| )name:` for every declared name, longest first so a name can be a prefix of another. */
function labelPattern(names: readonly string[]): RegExp {
  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`(^|\\s)(${alternation}):`, "g");
}

function stripQuotes(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2]!.trim() : value;
}

/**
 * The declared argument still waiting for a value.
 *
 * `files` count as filled when anything was attached, since the composer hands
 * them over whole rather than as a line of text.
 */
export function missingArgument(
  meta: CommandMeta,
  values: Readonly<Record<string, string>>,
  files: readonly unknown[],
): CommandArgument | undefined {
  return (meta.arguments ?? []).find((arg) => {
    if (!arg.required) return false;
    return arg.kind === "files" ? files.length === 0 : !values[arg.name];
  });
}

/**
 * How the command is written out, for a hint or an error: `prompt:<text>
 * [size:<WxH>]`. Required arguments first, then the optional ones.
 */
export function commandUsage(meta: CommandMeta): string {
  const declared = meta.arguments ?? [];
  if (declared.length === 0) return `/${meta.name}`;

  const part = (arg: CommandArgument) => {
    const value = arg.kind === "files" ? "<files>" : `<${arg.kind === "choice" ? "one" : "text"}>`;
    return `${arg.name}:${value}`;
  };
  const required = declared.filter((arg) => arg.required).map(part);
  const optional = declared.filter((arg) => !arg.required).map((arg) => `[${part(arg)}]`);
  return [`/${meta.name}`, ...required, ...optional].join(" ");
}
