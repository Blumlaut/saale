/**
 * Line diffs for a tool card.
 *
 * An `edit` call carries the text it replaced and the text it wrote, and the
 * result only says how many blocks it touched. The diff is therefore recomputed
 * here from the arguments, which is also what the call shows while it is still
 * being prepared.
 *
 * Lines keep the prefix the diff renderer colours on: ` ` unchanged, `-`
 * removed, `+` added.
 */

/**
 * Cells the longest-common-subsequence table may hold. Past it the edit is
 * rendered as a whole-block replacement rather than freezing the transcript on
 * a matrix nobody can read anyway.
 */
const MAX_DIFF_CELLS = 250_000;

/** Separator between the diffs of two edits in the same call. */
const EDIT_SEPARATOR = " ";

export interface TextEdit {
  oldText: string;
  newText: string;
}

/** The diff of a run of edits, each one separated by a blank context line. */
export function diffEdits(edits: readonly TextEdit[]): string[] {
  return edits.flatMap((edit, index) => {
    const lines = diffLines(edit.oldText, edit.newText);
    return index === 0 ? lines : [EDIT_SEPARATOR, ...lines];
  });
}

/** The diff between two blocks of text, one prefixed line at a time. */
export function diffLines(oldText: string, newText: string): string[] {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    return [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)];
  }

  const width = newLines.length + 1;
  /** Length of the common subsequence from each cell to the end of both texts. */
  const common = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      common[i * width + j] =
        oldLines[i] === newLines[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) {
      // Removals come first so a changed line reads as `-old` followed by `+new`.
      lines.push(`-${oldLines[i]}`);
      i++;
    } else {
      lines.push(`+${newLines[j]}`);
      j++;
    }
  }
  for (; i < oldLines.length; i++) lines.push(`-${oldLines[i]}`);
  for (; j < newLines.length; j++) lines.push(`+${newLines[j]}`);

  return lines;
}

/**
 * A text's lines. A trailing newline ends the last line rather than opening an
 * empty one, so an edit that only changes a line's content shows no phantom
 * blank line.
 */
function toLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** How many lines a text has, counting a trailing newline as ending the last one. */
export function lineCount(text: string): number {
  return toLines(text).length;
}
