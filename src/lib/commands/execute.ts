import { getCommandMeta, type CommandName } from "./catalog";
import { COMMAND_HANDLERS } from "./handlers";
import type { CommandContext, CommandOption, CommandOutcome, CommandPrompt } from "./types";

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
 * Interactive commands resolve their choices through `prepare`; when the user
 * already supplied an argument naming one of those options (`/stfu stop`), the
 * command runs straight away instead of asking.
 *
 * Server-only: the handlers reach the database, Redis and the Telegram API.
 */
export async function executeCommand(
  name: string,
  ctx: CommandContext,
  value?: string,
): Promise<ExecuteCommandResult> {
  const normalized = name.toLowerCase();
  const meta = getCommandMeta(normalized);
  if (!meta) {
    return { kind: "error", name: normalized, error: `Unknown command: /${normalized}` };
  }
  if (!meta.surfaces.includes(ctx.surface)) {
    return { kind: "error", name: normalized, error: `/${normalized} is not available here.` };
  }

  const handler = COMMAND_HANDLERS[meta.name as CommandName];

  try {
    if (!handler.prepare) {
      return { kind: "done", name: normalized, outcome: await handler.run(ctx) };
    }

    const prompt = await handler.prepare(ctx);
    const chosen = await resolveChoice(name, ctx, prompt, value);
    if (chosen.error) {
      return { kind: "error", name: normalized, error: chosen.error };
    }
    if (chosen.value !== undefined) {
      return { kind: "done", name: normalized, outcome: await handler.run(ctx, chosen.value) };
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
  ctx: CommandContext,
  prompt: CommandPrompt,
  value: string | undefined,
): { value?: string; error?: string } {
  if (value !== undefined) {
    const allowed = prompt.options.some((option) => option.value === value);
    return allowed ? { value } : { error: `Unknown option for /${name}: ${value}` };
  }

  if (!ctx.args) return {};

  const match = matchOption(prompt.options, ctx.args);
  if (!match) {
    if (prompt.options.length === 0) {
      return { error: `/${name} has nothing to offer right now.` };
    }
    const options = prompt.options.map((option) => option.value).join(", ");
    return { error: `Unknown option for /${name}: ${ctx.args}. Options: ${options}` };
  }
  return { value: match };
}

/** Match an argument against an option's value or label (case-insensitive). */
function matchOption(options: CommandOption[], arg: string): string | undefined {
  const wanted = arg.trim().toLowerCase();
  return options.find(
    (option) => option.value.toLowerCase() === wanted || option.label.toLowerCase() === wanted,
  )?.value;
}
