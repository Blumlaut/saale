/**
 * Telegram message splitting.
 *
 * Telegram enforces a hard limit of 4096 characters per message, measured in
 * UTF-16 code units (i.e. JS `String.length`). For MarkdownV2 the limit must
 * be computed on the *escaped* text. the backslashes added by the markdown
 * converter count toward the limit. so we split the converted output, not
 * the raw markdown.
 *
 * A split chunk is only acceptable if it parses as MarkdownV2 on its own:
 * every entity (bold/italic/code/spoiler/link) must be closed within the
 * chunk and no chunk may end inside a fenced code block. The splitters below
 * guarantee that.
 */

/** Telegram's hard per-message limit (UTF-16 code units). */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * One bit per MarkdownV2 entity-toggling character. At a chunk boundary every
 * bit must be clear (even parity) or an entity span would be left open and
 * Telegram rejects the message with "can't parse entities".
 *
 * Only unescaped occurrences toggle. `\*`, `\_` etc. are literal characters.
 */
const ENTITY_BITS: Record<string, number> = {
  "*": 1,
  _: 2,
  "`": 4,
  "|": 8,
  "[": 16,
  "]": 32,
};

/**
 * Entity parity of a string as a bitmask: bit set = odd number of unescaped
 * occurrences of that character.
 */
function entityParity(text: string): number {
  let state = 0;
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else {
      const bit = ENTITY_BITS[ch];
      if (bit !== undefined) state ^= bit;
    }
  }

  return state;
}

/**
 * Split plain text (no parse mode, HTML, legacy Markdown) into chunks of at
 * most `maxLength` characters, preferring word boundaries, then newlines,
 * force-splitting as a last resort.
 */
export function splitPlainText(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (at a space or newline)
    let splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt === -1) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt === -1) {
      // No space found. force split at maxLength
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

interface FenceBlock {
  opening: string;
  content: string[];
  closing: string;
}

type Block = { type: "line"; text: string } | ({ type: "fence" } & FenceBlock);

/** Fenced code blocks in converted output use bare ``` delimiter lines. */
function isFenceLine(line: string): boolean {
  return line.trim().startsWith("```");
}

/**
 * Group lines into blocks: fenced code blocks are atomic (an unclosed fence
 * makes MarkdownV2 unparseable), every other line is its own block.
 */
function segmentBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (isFenceLine(line)) {
      const opening = line;
      const content: string[] = [];
      i++;

      while (i < lines.length && !isFenceLine(lines[i] ?? "")) {
        content.push(lines[i] ?? "");
        i++;
      }

      const closing = i < lines.length ? (lines[i] ?? "") : "```";
      if (i < lines.length) i++;

      blocks.push({ type: "fence", opening, content, closing });
    } else {
      blocks.push({ type: "line", text: line });
      i++;
    }
  }

  return blocks;
}

/**
 * Split a single piece of text (one line, or a merged run of lines) into
 * pieces of at most `maxLength` characters.
 *
 * Prefers the furthest cut point that sits on a whitespace character with
 * every entity closed; falls back to any entity-balanced position, then to a
 * hard cut. Never cuts between a backslash and the character it escapes.
 *
 * This is the last-resort splitter. used when a single line (or an entity
 * span) is longer than the whole limit.
 */
function hardSplitLine(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const pieces: string[] = [];
  let rest = text;

  while (rest.length > maxLength) {
    let state = 0;
    let escaped = false;
    let bestSpace = -1; // furthest whitespace cut point with all entities closed
    let lastBalanced = -1; // furthest cut point with all entities closed

    for (let i = 1; i <= maxLength && i < rest.length; i++) {
      const ch = rest.charAt(i - 1);

      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        const bit = ENTITY_BITS[ch];
        if (bit !== undefined) state ^= bit;
      }

      // Cut point i sits after char i-1. It is unsafe when that char is an
      // opening backslash whose escaped partner would land in the next piece.
      if (!escaped && state === 0) {
        lastBalanced = i;
        if (/\s/.test(ch)) bestSpace = i;
      }
    }

    const cut = bestSpace !== -1 ? bestSpace : lastBalanced !== -1 ? lastBalanced : maxLength;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Split plain code-fence content into pieces of at most `budget` characters,
 * breaking at line boundaries where possible. Content inside a fence is
 * literal (no entity parsing), so the only rule is the length budget plus
 * not splitting a backslash escape in half.
 */
function splitFenceContent(content: string, budget: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
  };

  for (const line of content.split("\n")) {
    if (line.length > budget) {
      flush();
      parts.push(...hardSplitLine(line, budget));
      continue;
    }

    const addLen = line.length + (current.length > 0 ? 1 : 0);
    if (currentLen + addLen > budget) flush();

    current.push(line);
    currentLen += addLen;
  }

  flush();
  return parts;
}

/**
 * Split a fenced code block that alone exceeds `maxLength` by re-wrapping its
 * content in multiple smaller fenced blocks.
 */
function splitFenceBlock(block: FenceBlock, maxLength: number): string[] {
  // \n after opening fence + \n before closing fence
  const overhead = block.opening.length + block.closing.length + 2;
  const budget = maxLength - overhead;

  if (budget <= 0) {
    // Pathological: the fence lines alone exceed the limit. Deliver the
    // content anyway, even if it stops rendering as a code block.
    return splitPlainText([block.opening, ...block.content, block.closing].join("\n"), maxLength);
  }

  const content = block.content.join("\n");
  const parts = content.length === 0 ? [""] : splitFenceContent(content, budget);

  return parts.map((part) => `${block.opening}\n${part}\n${block.closing}`);
}

/**
 * Split converted Telegram MarkdownV2 text into chunks of at most
 * `maxLength` characters, each parseable as MarkdownV2 on its own.
 *
 * Chunks are separated at line boundaries where no entity is open, and a
 * fenced code block is never split across chunks (its content is re-wrapped
 * in fresh fences instead). For splits at line boundaries only,
 * `chunks.join("\n")` restores the input exactly.
 */
export function splitMarkdownV2(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const blocks = segmentBlocks(text.split("\n"));

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let parity = 0; // entity parity of the current chunk (0 = balanced)

  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join("\n"));
    current = [];
    currentLen = 0;
    parity = 0;
  };

  for (const block of blocks) {
    if (block.type === "fence") {
      const fenceLen =
        block.opening.length + 1 + block.content.join("\n").length + 1 + block.closing.length;

      if (fenceLen > maxLength) {
        // A single code block is bigger than an entire message. re-wrap its
        // content in multiple fences.
        flush();
        chunks.push(...splitFenceBlock(block, maxLength));
        continue;
      }

      const addLen = fenceLen + (current.length > 0 ? 1 : 0);
      if (currentLen + addLen > maxLength) flush();

      // Fence content is literal: it carries no entity state, so parity is
      // untouched (an entity can never span across a fence in converted
      // output. the converter escapes such unbalanced delimiters).
      for (const line of [block.opening, ...block.content, block.closing]) {
        currentLen += (current.length > 0 ? 1 : 0) + line.length;
        current.push(line);
      }
      continue;
    }

    const line = block.text;
    const addLen = line.length + (current.length > 0 ? 1 : 0);

    if (currentLen + addLen > maxLength) {
      if (current.length === 0) {
        // A single line longer than the limit. hard split it.
        chunks.push(...hardSplitLine(line, maxLength));
        continue;
      }

      if (parity !== 0) {
        // An entity (bold/italic/code span) reaches across this line, so the
        // chunk cannot close here. Merge the open run with the line and hard
        // split it, preferring entity-balanced cut points.
        const merged = [...current, line].join("\n");
        current = [];
        currentLen = 0;
        parity = 0;
        chunks.push(...hardSplitLine(merged, maxLength));
        continue;
      }

      flush();
    }

    currentLen += addLen;
    current.push(line);
    parity ^= entityParity(line);
  }

  flush();
  return chunks;
}
