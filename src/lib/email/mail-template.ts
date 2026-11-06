/**
 * The frame around the mails Saale writes about an account: a card, the
 * instance's name, one button, and the link again as text for clients that
 * strip buttons.
 *
 * Mail clients render their own way, so the markup is tables with inline
 * styles and nothing loaded from the network. The inline styles are the light
 * theme, which every client honours; the head's media query repaints them for
 * the ones that follow the reader's colour scheme.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The light theme, spelled out because a mail cannot read the app's tokens. */
const INK = "#111827";
const INK_MUTED = "#6b7280";
const INK_FAINT = "#9ca3af";
const ACCENT = "#f97316";
const SURFACE = "#ffffff";
const PAGE = "#f7f8fa";
const BORDER = "#e5e7e8";

/**
 * The same roles in the dark theme. A client that takes the media query swaps
 * them; Gmail ignores it and inverts the message itself.
 */
const DARK = {
  ink: "#f5f5f7",
  inkMuted: "#a1a1aa",
  inkFaint: "#71717a",
  accent: "#ff7a2e",
  surface: "#161618",
  page: "#0b0b0c",
  border: "#2a2a2e",
};

const DARK_STYLE = `<style>
@media (prefers-color-scheme: dark) {
  .mail-page { background:${DARK.page} !important; }
  .mail-card { background:${DARK.surface} !important; border-color:${DARK.border} !important; }
  .mail-ink, .mail-brand { color:${DARK.ink} !important; }
  .mail-button { background:${DARK.accent} !important; color:${DARK.page} !important; }
  .mail-note, .mail-link { color:${DARK.inkMuted} !important; }
  .mail-fine { color:${DARK.inkFaint} !important; }
}
</style>`;

/**
 * The instance's name lands in the markup, and an admin types it. Escaping it
 * keeps a stray `&` or `<` from breaking the message.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AccountMailParts {
  instanceName: string;
  /** The sentence above the button. */
  heading: string;
  url: string;
  linkLabel: string;
  /** The small print: how long the link lasts, and what to do if it was not you. */
  note: string;
}

/** The plain-text and HTML halves of one account mail. */
export interface RenderedAccountMail {
  text: string;
  html: string;
}

export function renderAccountMail({
  instanceName,
  heading,
  url,
  linkLabel,
  note,
}: AccountMailParts): RenderedAccountMail {
  const name = escapeHtml(instanceName);
  const href = escapeHtml(url);

  const text = [heading, "", url, "", note, "", instanceName].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
${DARK_STYLE}
</head>
<body class="mail-page" style="margin:0;padding:0;background:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="mail-page" style="background:${PAGE}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="mail-card" style="max-width:520px;background:${SURFACE};border:1px solid ${BORDER};border-radius:16px">
<tr><td style="padding:32px;font-family:${FONT}">
<p class="mail-brand" style="margin:0 0 24px;font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${INK}"><span style="color:${ACCENT}">&#8250;</span> ${name}</p>
<p class="mail-ink" style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${INK}">${escapeHtml(heading)}</p>
<p class="mail-button-row" style="margin:0 0 24px;text-align:center"><a href="${href}" class="mail-button" style="display:inline-block;background:${ACCENT};color:${INK};font-family:${FONT};font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:999px">${escapeHtml(linkLabel)}</a></p>
<p class="mail-note" style="margin:0;font-size:13px;line-height:1.6;color:${INK_MUTED}">${escapeHtml(note)}</p>
</td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px">
<tr><td align="left" class="mail-fine" style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${INK_FAINT};word-break:break-all">If the button does nothing, paste this into a browser:<br><a href="${href}" class="mail-link" style="color:${INK_MUTED}">${href}</a></td></tr>
<tr><td align="left" class="mail-fine" style="padding:8px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${INK_FAINT}">Sent by ${name}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { text, html };
}
