/**
 * Argument placeholders, in Pi's syntax.
 *
 * A prompt template is documented and written the way Pi documents its own:
 * `$1`, `$@`/`$ARGUMENTS`, `${N:-default}`, `${@:N}`, `${@:N:L}`. Pi keeps its
 * parser internal (the package exports no deep path to it), so this mirrors
 * its behaviour instead of importing it, and the two must stay in step.
 */

/** Split an argument string on whitespace, keeping quoted runs together. */
export function parsePromptArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  // Tracks whether a token started, so `""` is an empty argument, not nothing.
  let hasToken = false;
  let inQuote: string | null = null;

  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }

  if (hasToken) args.push(current);
  return args;
}

/** Fill a template's placeholders from the arguments the user typed. */
export function substitutePromptArgs(content: string, args: readonly string[]): string {
  const allArgs = args.join(" ");

  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      defaultTarget?: string,
      defaultValue?: string,
      sliceStart?: string,
      sliceLength?: string,
      simple?: string,
    ) => {
      if (defaultTarget) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? allArgs
            : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : (defaultValue ?? "");
      }
      if (sliceStart) {
        // Arguments are 1-indexed on the way in. `0` reads as `1`, like bash.
        const start = Math.max(parseInt(sliceStart, 10) - 1, 0);
        const end = sliceLength ? start + parseInt(sliceLength, 10) : undefined;
        return args.slice(start, end).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      const index = parseInt(simple ?? "0", 10) - 1;
      return args[index] ?? "";
    },
  );
}
