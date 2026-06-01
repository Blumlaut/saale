/**
 * Sanitize HTML content from email messages to prevent XSS, CSS injection,
 * and other client-side attacks.
 *
 * Uses DOMPurify with a whitelist tuned for safe email rendering:
 * - Strips <script>, event handlers, javascript: URLs, <iframe>
 * - Strips dangerous CSS properties (expression, url, behavior, -moz-binding)
 * - Allows standard email formatting: tables, images, inline styles, links
 *
 * Post-processing adds extra safety: CSS sanitization and link hardening.
 */
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Initialize DOMPurify with a JSDOM window (required in Node.js environments)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSDOM window is compatible at runtime
const jsdomWindow = new JSDOM("<!DOCTYPE html>").window as any;
const purify = DOMPurify(jsdomWindow);

/**
 * Post-process sanitized HTML to harden against CSS injection and link attacks.
 * DOMPurify handles structural XSS; this catches CSS-level attacks and hardens links.
 */
function postProcess(html: string): string {
  // Parse into a DOM for manipulation
  const doc = new jsdomWindow.DOMParser().parseFromString(html, "text/html");

  // Strip dangerous CSS from inline styles
  const styledElements = doc.querySelectorAll("[style]");
  for (const el of Array.from(styledElements) as Element[]) {
    const style = el.getAttribute("style");
    if (style) {
      const safe = style
        .replace(/expression\s*\([^)]*\)/gi, "")
        .replace(/url\s*\([^)]*\)/gi, "")
        .replace(/behavior\s*:[^;]*/gi, "")
        .replace(/-moz-binding\s*:[^;]*/gi, "")
        .replace(/javascript\s*:[^;]*/gi, "")
        .replace(/vbscript\s*:[^;]*/gi, "");
      el.setAttribute("style", safe);
    }
  }

  // Harden links: block dangerous protocols, set safe target/rel
  const links = doc.querySelectorAll("a[href]");
  for (const link of Array.from(links) as Element[]) {
    const href = link.getAttribute("href") ?? "";
    const protocol = href.trim().split(":")[0]?.toLowerCase();

    if (protocol === "javascript" || protocol === "vbscript" || protocol === "data") {
      link.removeAttribute("href");
    } else {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }

  // Get just the body content (not the full document)
  const inner = doc.body.innerHTML;
  // Wrap in a container div for theme-aware CSS scoping (see globals.css .email-content)
  return inner ? `<div class="email-content">${inner}</div>` : "";
}

/**
 * Sanitize raw HTML from an email message body.
 *
 * Returns `null` when input is empty/null, otherwise returns sanitized HTML string.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (!html) return null;

  // Phase 1: DOMPurify structural sanitization
  const sanitized = purify.sanitize(html, {
    // Allow standard email formatting elements
    ADD_TAGS: [
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "caption",
      "colgroup",
      "col",
      "div",
      "span",
      "p",
      "br",
      "hr",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "blockquote",
      "pre",
      "code",
      "img",
      "a",
      "b",
      "i",
      "u",
      "s",
      "strike",
      "sub",
      "sup",
      "strong",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "font",
      "small",
      "big",
      "abbr",
      "cite",
      "mark",
    ],

    // Allow safe attributes used in email formatting
    ADD_ATTR: [
      "border",
      "cellpadding",
      "cellspacing",
      "colspan",
      "rowspan",
      "bgcolor",
      "width",
      "height",
      "align",
      "valign",
      "href",
      "target",
      "rel",
      "src",
      "alt",
      "title",
      "style",
      "class",
      "id",
      "color",
      "face",
      "size",
      "lang",
      "dir",
      "type",
      "start",
      "data-*",
    ],

    // Forbid dangerous elements entirely
    FORBID_TAGS: [
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "applet",
      "script",
      "style",
      "link",
      "meta",
      "base",
      "form",
      "input",
      "button",
      "select",
      "textarea",
      "label",
    ],

    // Strip xmlns attributes (XML injection)
    FORBID_ATTR: ["xmlns", "xmlns:xlink"],

    // Sanitize DOM to prevent id/class injection attacks
    SANITIZE_DOM: true,

    // Return string (default) — post-processing handles the rest
    RETURN_DOM_FRAGMENT: false,
  });

  if (!sanitized) return null;

  // Phase 2: Post-processing for CSS and link hardening
  const hardened = postProcess(sanitized as string);
  return hardened || null;
}
