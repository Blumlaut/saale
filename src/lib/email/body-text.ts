import { convert } from "html-to-text";

/**
 * Deepest element nesting converted. html-to-text walks the tree recursively and
 * mailparser caps its own conversion at the same depth.
 */
const MAX_HTML_NESTING_DEPTH = 1000;

/** No wrapping, so a converted body reads as whole sentences. */
const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false,
  limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
} as const;

/**
 * Plain text of a mail body: the text part when it has content, else the html part
 * converted.
 *
 * mailparser leaves `text` unset for a multipart/alternative that carries only an
 * html part, which is how a lot of marketing mail is built. Converting the html
 * keeps such a message readable instead of empty.
 */
export function emailBodyText(parts: {
  text?: string | false | null | undefined;
  html?: string | false | null | undefined;
}): string | null {
  const text = typeof parts.text === "string" ? parts.text : "";
  if (text.trim()) return text;

  const html = typeof parts.html === "string" ? parts.html : "";
  if (!html) return null;

  try {
    return convert(html, HTML_TO_TEXT_OPTIONS).trim() || null;
  } catch (err) {
    console.error("[email] Failed to convert an html body to text:", err);
    return null;
  }
}
