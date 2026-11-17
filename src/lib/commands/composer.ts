/**
 * What the composer's `/` menu offers while a command is being filled in.
 *
 * The command line is `name:value` pairs, so the menu follows the caret: after
 * `/image ` it lists the argument names, and inside `size:` it lists that
 * argument's values. A bare word that names no argument completes the first
 * argument's values, so `/model qwen` picks a model straight away. Pure
 * functions over the composer's text, so the composer stays a component and
 * this stays testable.
 */

import { choiceValue, missingArgument, parseCommandArguments } from "./arguments";
import {
  BOOLEAN_VALUES,
  type CommandArgument,
  type CommandArgumentKind,
  type CommandMeta,
  type CommandOption,
  type CommandOptions,
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
 * filled in. A bare word that names no argument completes the first unfilled
 * argument's values.
 */
export function argumentHints(
  meta: CommandMeta | undefined,
  args: string,
  context: {
    /** Files the composer is holding, which fill a `files` argument. */
    attached?: number;
    /** Values the server listed for a dynamic argument, keyed by its name. */
    options?: CommandOptions | undefined;
  } = {},
): ArgumentCompletion | null {
  const declared = meta?.arguments ?? [];
  if (declared.length === 0) return null;
  const attached = context.attached ?? 0;

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
    const choices = (typed ? candidates(typed, context.options) : []).filter(
      (candidate) =>
        candidate.value.toLowerCase() !== value && candidate.value.toLowerCase().includes(value),
    );
    return choices.length === 0 || !typed
      ? null
      : {
          hints: choices.map((candidate) => valueHint(candidate, typed, candidate.value)),
          replace: { start: start + colon + 1, end: args.length },
        };
  }

  const query = token.toLowerCase();
  const filled = new Set(filledArguments(args, declared));
  const unfilled = declared.filter((arg) => !filled.has(arg.name));
  const wanted = unfilled.filter((arg) => arg.name.toLowerCase().startsWith(query));

  if (wanted.length > 0) {
    return {
      hints: wanted.map((arg) => hint(arg, attached, context.options)),
      replace: { start, end: args.length },
    };
  }

  // A word that names no argument is a value for the first one still waiting:
  // `/model qwen` completes the model right after the command is picked.
  const target = unfilled[0];
  if (!target || (target.kind !== "choice" && target.kind !== "boolean")) return null;
  const values = candidates(target, context.options).filter((candidate) =>
    candidate.value.toLowerCase().includes(query),
  );
  return values.length === 0
    ? null
    : {
        hints: values.map((candidate) =>
          valueHint(candidate, target, `${target.name}:${candidate.value}`),
        ),
        replace: { start, end: args.length },
      };
}

/** A value row: the argument's name is the note, the option's label the description. */
function valueHint(candidate: Candidate, arg: CommandArgument, insert: string): ArgumentHint {
  return {
    insert,
    label: candidate.value,
    description: candidate.description,
    kind: arg.kind,
    note: arg.name,
    target: "value",
  };
}

/** One value an argument accepts, and what to say about it. */
interface Candidate {
  value: string;
  description: string;
}

/**
 * Every value an argument accepts.
 *
 * The catalog lists a fixed choice itself; a choice without one comes from the
 * server, which is the only side that knows a model's resolutions.
 */
function candidates(arg: CommandArgument, options: CommandOptions | undefined): Candidate[] {
  if (arg.kind === "boolean") return BOOLEAN_VALUES.map((value) => ({ value, description: "" }));
  if (arg.kind !== "choice") return [];

  const listed: CommandOption[] =
    arg.choices === undefined
      ? (options?.[arg.name] ?? [])
      : arg.choices.map((choice) => {
          const value = choiceValue(choice);
          const label = typeof choice === "string" ? "" : choice.label;
          return { value, label };
        });

  return listed.map((option) => ({
    value: option.value,
    // Nothing to add when the label already appears in the value
    // (`provider:model` beside `model`), or when it is the value itself.
    description:
      option.description ??
      (option.label && !option.value.endsWith(option.label) ? option.label : ""),
  }));
}

function hint(
  arg: CommandArgument,
  attached: number,
  options: CommandOptions | undefined,
): ArgumentHint {
  const values = candidates(arg, options).map((candidate) => candidate.value);
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
