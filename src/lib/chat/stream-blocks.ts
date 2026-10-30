/**
 * Cutting a streaming message into blocks.
 *
 * `react-markdown` runs its whole pipeline over the whole document on every
 * render: parse, mdast to hast, syntax highlighting, then React reconciles
 * every element again. Text that arrives a token at a time pays all of that per
 * frame, so a long answer costs its own length per token twice over. Only the
 * last block is still being written, so the ones before it can be rendered once
 * and left alone.
 *
 * A blank line is not a block boundary, so the scan tracks what the document is
 * inside: a loose list, a blockquote and a fenced code block all carry on across
 * one. Anything the scan cannot read (raw HTML, link and footnote definitions,
 * which resolve per document) leaves the message as one block.
 */

/** A list item: `-`, `*`, `+` or `1.` / `1)`, up to three spaces in. */
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A blockquote marker. */
const QUOTE_MARKER = /^ {0,3}>/;
/** A code fence's opening or closing line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Content indented far enough to belong to the block above it. */
const INDENTED = /^(?: {2,}|\t)/;
/** A raw HTML block, which can span blank lines. */
const HTML_BLOCK = /^ {0,3}</m;
/** A link or footnote definition, which resolves across blocks. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * The blocks of `source` in order, joining back up to the whole of it. The last
 * one is the block still being written; the others are finished.
 */
export function streamBlocks(source: string): string[] {
  if (!source) return [];
  if (HTML_BLOCK.test(source) || DEFINITION.test(source)) return [source];

  const boundaries = blockBoundaries(source);
  if (boundaries.length === 0) return [source];

  const blocks: string[] = [];
  let from = 0;
  for (const boundary of boundaries) {
    if (boundary <= from || boundary >= source.length) continue;
    blocks.push(source.slice(from, boundary));
    from = boundary;
  }
  blocks.push(source.slice(from));
  return blocks;
}

/**
 * Where each block of `source` starts, in order. The first block starts at 0,
 * so it is not listed.
 */
function blockBoundaries(source: string): number[] {
  const boundaries: number[] = [];
  let open: null | "fence" | "list" | "quote" = null;
  let fence = "";
  let previousBlank = true;

  let offset = 0;
  while (offset < source.length) {
    const lineEnd = source.indexOf("\n", offset);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(offset, end);
    const start = offset;
    offset = end + 1;

    if (line.trim() === "") {
      previousBlank = true;
      continue;
    }

    if (open === "fence") {
      if (line.trimEnd() === fence) open = null;
      previousBlank = false;
      continue;
    }

    if (open === "list") {
      // A list goes on through its own items, their indented content and a lazy
      // continuation line. A line at the margin after a blank one ends it.
      if (LIST_MARKER.test(line) || INDENTED.test(line) || !previousBlank) {
        previousBlank = false;
        continue;
      }
      open = null;
    } else if (open === "quote") {
      if (QUOTE_MARKER.test(line) || !previousBlank) {
        previousBlank = false;
        continue;
      }
      open = null;
    }

    // Everything that reaches this line starts a block of its own.
    if (previousBlank) boundaries.push(start);

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      open = "fence";
      fence = fenceMatch[1]!;
    } else if (LIST_MARKER.test(line)) {
      open = "list";
    } else if (QUOTE_MARKER.test(line)) {
      open = "quote";
    }
    previousBlank = false;
  }

  return boundaries;
}
