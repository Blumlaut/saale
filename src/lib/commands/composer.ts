/**
 * What the composer's `/` menu offers while a command is being filled in.
 *
 * The command line is `name:value` pairs, so the menu follows the caret: after
 * `/image ` it lists the argument names, and inside `size:` it lists that
 * argument's values. Pure functions over the composer's text, so the composer
 * stays a component and this stays testable.
 */

import { missingArgument, parseCommandArguments } from "./arguments";
import {
  BOOLEAN_VALUES,
  type CommandArgument,
  type CommandArgumentKind,
  type CommandMeta,
} from "./types";

/** A composer value split into the command and what follows it. */
export interface CommandDraft {
  name: string;
  /** Everything after the first space, as typed. "" when nothing follows. */
  args: string;
}

/** One row of the composer's argument menu. */
export interface ArgumentHint {
  /** What completion puts in the composer. "" for the file picker. */
  insert: string;
  label: string;
  description: string;
  kind: CommandArgumentKind;
  /** `required` or `optional`. */
  note?: string;
  /** For `files`: how many the composer already holds. */
  attached?: number;
  /** The values the argument accepts, for the row's hint: `true | false`. */
  values?: readonly string[];
  /** Whether picking this row fills an argument's name or one of its values. */
  target: "argument" | "value";
}

export interface ArgumentCompletion {
  hints: ArgumentHint[];
  /** The part of `draft.args` the picked hint replaces. */
  replace: { start: number; end: number };
}

/**
 * The command a composer value is typing, or null when it is just a message.
 *
 * `/name` alone is a draft too: the name menu is still deciding. A slash with
 * no name yet is not, since the caller filters the command list by that prefix.
 */
export function readCommandDraft(text: string): CommandDraft | null {
  const match = /^\s*\/([a-z0-9_-]+)(?:\s([\s\S]*))?$/i.exec(text);
  const name = match?.[1];
  if (!name) return null;
  return { name: name.toLowerCase(), args: match[2] ?? "" };
}

/**
 * Whether the command can run with what has been typed.
 *
 * Enter completes the argument under the highlight only when the command would
 * otherwise fail: `/stop ` runs, `/image ` fills in its required prompt first.
 */
export function commandReady(meta: CommandMeta | undefined, args: string, attached = 0): boolean {
  if (!meta) return false;
  const values = parseCommandArguments(args, meta.arguments).values;
  return missingArgument(meta, values, Array.from({ length: attached })) === undefined;
}

/**
 * The argument rows for the text typed so far, and the range a pick replaces.
 *
 * Returns null when there is nothing to offer: the text is inside the value of
 * a free-text argument, or every argument the command declares is already
 * filled in.
 */
export function argumentHints(
  meta: CommandMeta | undefined,
  args: string,
  attached = 0,
): ArgumentCompletion | null {
  const declared = meta?.arguments ?? [];
  if (declared.length === 0) return null;

  const start = Math.max(args.lastIndexOf(" "), args.lastIndexOf("\n")) + 1;
  const token = args.slice(start);
  const colon = token.indexOf(":");

  if (colon >= 0) {
    const name = token.slice(0, colon).toLowerCase();
    const typed = declared.find(
      (arg) => (arg.kind === "choice" || arg.kind === "boolean") && arg.name === name,
    );
    const value = token.slice(colon + 1).toLowerCase();
    // A value typed out in full is done; offering it again would swallow Enter.
    const values = (typed ? argumentValues(typed) : []).filter(
      (candidate) => candidate.toLowerCase() !== value && candidate.toLowerCase().startsWith(value),
    );
    return values.length === 0 || !typed
      ? null
      : {
          hints: values.map((candidate) => ({
            insert: candidate,
            label: candidate,
            description: typed.description,
            kind: typed.kind,
            target: "value" as const,
          })),
          replace: { start: start + colon + 1, end: args.length },
        };
  }

  const query = token.toLowerCase();
  const filled = new Set(filledArguments(args, declared));
  const wanted = declared.filter(
    (arg) => !filled.has(arg.name) && arg.name.toLowerCase().startsWith(query),
  );

  return wanted.length === 0
    ? null
    : {
        hints: wanted.map((arg) => hint(arg, attached)),
        replace: { start, end: args.length },
      };
}

/** The values an argument accepts, when a surface can list them itself. */
function argumentValues(arg: CommandArgument): readonly string[] {
  if (arg.kind === "boolean") return BOOLEAN_VALUES;
  if (arg.kind === "choice") return arg.choices ?? [];
  return [];
}

function hint(arg: CommandArgument, attached: number): ArgumentHint {
  const values = argumentValues(arg);
  return {
    insert: arg.kind === "files" ? "" : `${arg.name}:`,
    target: "argument" as const,
    label: arg.name,
    description: arg.description,
    kind: arg.kind,
    note: arg.required ? "required" : "optional",
    ...(values.length > 0 ? { values } : {}),
    ...(arg.kind === "files" ? { attached } : {}),
  };
}

/** Names that already have a value on the line. */
function filledArguments(args: string, declared: readonly CommandArgument[]): string[] {
  return declared
    .filter((arg) => arg.kind !== "files")
    .filter((arg) => new RegExp(`(^|\\s)${escape(arg.name)}:`, "i").test(args))
    .map((arg) => arg.name);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
