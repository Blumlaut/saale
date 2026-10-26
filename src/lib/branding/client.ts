/**
 * Client-side branding helpers. The stylesheet is linked from the root layout,
 * so it only needs poking after an admin saves a colour.
 */

const THEME_LINK_SELECTOR = 'link[rel="stylesheet"][data-branding-theme]';

/**
 * Re-fetch the branding stylesheet in place. The browser keeps the current
 * rules on screen until the new sheet arrives, so the accent swaps without a
 * full reload.
 */
export function reloadBrandingStyles(): void {
  const link = document.querySelector<HTMLLinkElement>(THEME_LINK_SELECTOR);
  if (!link) return;
  const url = new URL(link.href);
  url.searchParams.set("v", String(Date.now()));
  link.href = url.toString();
}
