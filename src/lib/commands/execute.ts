import {
  commandUsage,
  missingArgument,
  parseCommandArguments,
  validateArguments,
} from "./arguments";
import { getCommandMeta, type CommandName } from "./catalog";
import { COMMAND_HANDLERS } from "./handlers";
import type {
  CommandContext,
  CommandOption,
  CommandOutcome,
  CommandPrompt,
  CommandRequest,
} from "./types";

/**
 * The result of running a command:
 *
 * - `prompt`. an interactive command needs a choice before it can run; the
 *   surface renders the options (web: a sheet, Telegram: an inline keyboard)
 *   and calls back with the chosen `value`.
 * - `done`  . the command ran; the surface shows the outcome.
 * - `error` . nothing ran; the surface shows the message.
 */
export type ExecuteCommandResult =
  | { kind: "prompt"; name: string; prompt: CommandPrompt }
  | { kind: "done"; name: string; outcome: CommandOutcome }
  | { kind: "error"; name: string; error: string };

/**
 * Run a slash command for a surface.
 *
 * The argument line is read against what the command declares, so `prompt:a red
 * fox` reaches the handler as a named value whatever the surface. Required
 * arguments are checked here rather than in each handler, so the message a user
 * gets for a missing one reads the same everywhere.
 *
 * Interactive commands resolve their choices through `prepare`; when the user
 * already named one (`/stfu time:stop`, or the older `/stfu stop`), the command
 * runs straight away instead of asking.
 *
 * Server-only: the handlers reach the database, Redis and the Telegram API.
 */
export async function executeCommand(
  name: string,
  request: CommandRequest,
  value?: string,
): Promise<ExecuteCommandResult> {
  const normalized = name.toLowerCase();
  const meta = getCommandMeta(normalized);
  if (!meta) {
    return { kind: "error", name: normalized, error: `Unknown command: /${normalized}` };
  }
  if (!meta.surfaces.includes(request.surface)) {
    return { kind: "error", name: normalized, error: `/${normalized} is not available here.` };
  }

  const parsed = parseCommandArguments(request.args, meta.arguments);
  const checked = validateArguments(meta, parsed.values);
  if (checked.error) {
    return { kind: "error", name: normalized, error: checked.error };
  }
  const ctx: CommandContext = { ...request, arguments: checked.values };

  const missing = missingArgument(meta, checked.values, request.files);
  if (missing) {
    return {
      kind: "error",
      name: normalized,
      error: `/${normalized} needs a ${missing.name}: ${missing.description}. Usage: ${commandUsage(meta)}`,
    };
  }

  const handler = COMMAND_HANDLERS[meta.name as CommandName];

  try {
    if (!handler.prepare) {
      return { kind: "done", name: normalized, outcome: await handler.run(ctx) };
    }

    const prompt = await handler.prepare(ctx);
    const chosen = await resolveChoice(
      name,
      prompt,
      value,
      [...Object.values(checked.values), parsed.rest].filter((candidate) => candidate.length > 0),
    );
    if (chosen.error) {
      return { kind: "error", name: normalized, error: chosen.error };
    }
    if (chosen.value !== undefined) {
      return {
        kind: "done",
        name: normalized,
        outcome: await handler.run(ctx, chosen.value),
      };
    }
    return { kind: "prompt", name: normalized, prompt };
  } catch (err) {
    console.error(`Slash command /${normalized} failed:`, err);
    return {
      kind: "error",
      name: normalized,
      error: err instanceof Error ? err.message : "The command failed.",
    };
  }
}

/**
 * Decide whether an interactive command can run already.
 *
 * A value handed in by a surface is validated against the prompt's options
 * the web route accepts it from the client, so an unknown value must not reach
 * the handler. Without a value, an argument that names an option is matched
 * (case-insensitively, by value or label); no argument at all means "ask the
 * user".
 */
function resolveChoice(
  name: string,
  prompt: CommandPrompt,
  value: string | undefined,
  candidates: readonly string[],
): { value?: string; error?: string } {
  if (value !== undefined) {
    const allowed = prompt.options.some((option) => option.value === value);
    return allowed ? { value } : { error: `Unknown option for /${name}: ${value}` };
  }

  if (candidates.length === 0) return {};

  for (const candidate of candidates) {
    const match = matchOption(prompt.options, candidate);
    if (match !== undefined) return { value: match };
  }

  if (prompt.options.length === 0) {
    return { error: `/${name} has nothing to offer right now.` };
  }
  const options = prompt.options.map((option) => option.value).join(", ");
  return { error: `Unknown option for /${name}: ${candidates[0]}. Options: ${options}` };
}

/** Match an argument against an option's value or label (case-insensitive). */
function matchOption(options: CommandOption[], arg: string): string | undefined {
  const wanted = arg.trim().toLowerCase();
  return options.find(
    (option) => option.value.toLowerCase() === wanted || option.label.toLowerCase() === wanted,
  )?.value;
}
