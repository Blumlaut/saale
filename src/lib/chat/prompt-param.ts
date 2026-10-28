/**
 * The prompt a browser hands over when it opens a chat URL with `?q=`.
 *
 * Firefox's AI chatbot sidebar opens its configured provider with the prompt in
 * `?q=`: a `browser.ml.chat.prompts` template with the page's selection, title
 * and URL substituted into `<selection>`, `<tabTitle>` and `<pageUrl>`. Firefox
 * escapes those values on the way in, and nothing in the browser unescapes them
 * again.
 */

/** Query parameter a browser puts the prompt in. */
export const PROMPT_PARAM = "q";

/** Mirrors the server's message cap, so a long prompt is kept rather than rejected. */
const MAX_PROMPT_CHARS = 100_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Undo the escaping Firefox applies to the text it puts in a prompt. */
export function decodePromptEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, name: string) => {
    if (!name.startsWith("#")) {
      return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    }
    const code =
      name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return entity;
    return String.fromCodePoint(code);
  });
}

/** The ready-to-send message in a `?q=` value, or null when it carries none. */
export function readPromptParam(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = decodePromptEntities(value.replace(/\0/g, "")).trim().slice(0, MAX_PROMPT_CHARS);
  return text || null;
}
