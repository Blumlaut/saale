import type { CommandName } from "../catalog";
import type { CommandHandler } from "../types";
import { compactHandler } from "./compact";
import { modelHandler } from "./model";
import { newHandler } from "./new";
import { stfuHandler } from "./stfu";
import { stopHandler } from "./stop";

/**
 * Server-side implementation per command.
 *
 * Typed as a total map over the catalog: a command declared without a handler,
 * or a handler left behind for a command that no longer exists, fails
 * typecheck instead of failing at runtime.
 */
export const COMMAND_HANDLERS: Record<CommandName, CommandHandler> = {
  compact: compactHandler,
  model: modelHandler,
  new: newHandler,
  stfu: stfuHandler,
  stop: stopHandler,
};
