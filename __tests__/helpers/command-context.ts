import { parseCommandArguments, validateArguments } from "@/lib/commands/arguments";
import { getCommandMeta } from "@/lib/commands/catalog";
import type { CommandContext, CommandFile } from "@/lib/commands/types";

/**
 * The context `executeCommand` hands a handler: the command's line, read and
 * checked against what the catalog declares, plus whatever files came with it.
 */
export function webContext(
  command: string,
  args = "",
  files: readonly CommandFile[] = [],
): CommandContext {
  const meta = getCommandMeta(command);
  const parsed = parseCommandArguments(args, meta?.arguments);
  return {
    surface: "web",
    userId: "user-1",
    sessionId: "session-1",
    args,
    arguments: validateArguments(meta!, parsed.values).values,
    files,
  };
}

/** A picture the composer attached to a command. */
export function commandImage(name = "photo.png", path = `/home/user/uploads/${name}`): CommandFile {
  return { path, fileName: name, mimeType: "image/png", size: 2048 };
}
