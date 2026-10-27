import { expect, type Page } from "@playwright/test";

/**
 * Overlay layout contract (enforced by `modal-overflow.spec.ts`).
 *
 * An open overlay (dialog, alert dialog, sheet) must fit inside the viewport
 * and must never scroll horizontally as a whole:
 *
 *   1. The popup itself has no horizontal overflow (`scrollWidth <= clientWidth`)
 *       if it does, the user has to scroll the *modal* sideways, which is the
 *      bug class this guards against (a long unbreakable key/URL/token widening
 *      the popup's auto-sized grid track).
 *   2. The popup box stays inside the viewport.
 *   3. No descendant sticks out past the popup's padding box, unless it is a
 *      horizontally scrollable region that itself fits inside the popup (a wide
 *      table / wrapped code block the user can scroll *within* the modal).
 *
 * Root-cause fix for (1) lives in `src/components/ui/dialog.tsx`
 * (`*:min-w-0` on the popup's direct children). Leaf content must still wrap or
 * scroll on its own  see `AGENTS.md` → "Modals Must Fit".
 */

/** Popups rendered by the shared overlay primitives. */
export const OVERLAY_SELECTORS = [
  '[data-slot="dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="alert-dialog-content"]',
];

/** The same selectors, restricted to visible popups. */
export const OVERLAY_VISIBLE_SELECTOR = OVERLAY_SELECTORS.map((s) => `${s}:visible`).join(", ");

/** Wait until an overlay popup is open and its entry animation has finished. */
export async function waitForOverlay(page: Page): Promise<void> {
  const popup = page.locator(OVERLAY_VISIBLE_SELECTOR).last();
  await popup.waitFor({ state: "visible", timeout: 10_000 });
  // Sheets/dialogs animate in (fade + zoom, or a slide from off-screen): measure
  // the settled box, not a mid-flight transform.
  await popup
    .evaluate(async (element) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const finished = Promise.all(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      ).catch(() => []);
      await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    })
    .catch((err) => {
      console.warn("e2e: waiting for the overlay animation failed", err);
    });
}

export interface OverlayLayout {
  /** False when no overlay is open. */
  present: boolean;
  slot: string | null;
  /** Popup box, viewport coordinates. */
  rect: { left: number; right: number; top: number; bottom: number };
  clientWidth: number;
  scrollWidth: number;
  viewport: { width: number; height: number };
  /** Descendants escaping the popup's padding box horizontally. */
  offenders: string[];
  /** Descendants escaping the viewport horizontally. */
  viewportOffenders: string[];
  /** True when the page (html/body) itself scrolls horizontally. */
  documentOverflow: boolean;
}

/**
 * Measure the topmost open overlay. Runs in the page; keep it dependency-free.
 */
export async function measureOverlay(page: Page): Promise<OverlayLayout> {
  const selectors = OVERLAY_SELECTORS.join(", ");
  return page.evaluate((selector) => {
    const empty: OverlayLayout = {
      present: false,
      slot: null,
      rect: { left: 0, right: 0, top: 0, bottom: 0 },
      clientWidth: 0,
      scrollWidth: 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      offenders: [],
      viewportOffenders: [],
      documentOverflow: false,
    };

    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // Controls that hide their real input (Switch, Select, file inputs) park a
    // 1px transparent input at the viewport origin  it is not layout content.
    const isLayoutContent = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const style = getComputedStyle(el);
      return style.opacity !== "0" && style.visibility !== "hidden";
    };
    const overlays = [...document.querySelectorAll(selector)].filter(visible);
    const popup = overlays[overlays.length - 1];
    if (!popup) return empty;

    const rect = popup.getBoundingClientRect();
    const padLeft = rect.left + popup.clientLeft;
    const padRight = padLeft + popup.clientWidth;

    const describe = (el: Element) => {
      const slot = el.getAttribute("data-slot");
      const type = el.getAttribute("type");
      const label = el.getAttribute("aria-label") ?? el.getAttribute("name");
      const cls =
        typeof el.className === "string" ? el.className.trim().split(/\s+/).join(".") : "";
      return `${el.tagName.toLowerCase()}${type ? `[type=${type}]` : ""}${slot ? `[${slot}]` : ""}${label ? `[${label}]` : ""}${cls ? `.${cls.slice(0, 70)}` : ""}`;
    };

    // Content inside a horizontally scrollable region that fits within the
    // popup is reachable by scrolling, so it may legitimately be wider.
    const insideContainedScroller = (el: Element) => {
      let parent = el.parentElement;
      while (parent && parent !== popup.parentElement) {
        if (parent === popup) break;
        const style = getComputedStyle(parent);
        if (
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          parent.scrollWidth > parent.clientWidth + 2
        ) {
          const pRect = parent.getBoundingClientRect();
          const pLeft = pRect.left + parent.clientLeft;
          if (pLeft >= padLeft - 2 && pLeft + parent.clientWidth <= padRight + 2) return true;
        }
        parent = parent.parentElement;
      }
      return false;
    };

    const offenders: string[] = [];
    const viewportOffenders: string[] = [];
    for (const el of popup.querySelectorAll("*")) {
      if (!isLayoutContent(el)) continue;
      const r = el.getBoundingClientRect();
      if (insideContainedScroller(el)) continue;
      if (r.right > padRight + 2 || r.left < padLeft - 2) {
        if (offenders.length < 6) offenders.push(describe(el));
      }
      if (r.right > window.innerWidth + 2 || r.left < -2) {
        if (viewportOffenders.length < 6) viewportOffenders.push(describe(el));
      }
      if (offenders.length >= 6 && viewportOffenders.length >= 6) break;
    }

    const doc = document.documentElement;

    return {
      present: true,
      slot: popup.getAttribute("data-slot"),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      clientWidth: popup.clientWidth,
      scrollWidth: popup.scrollWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      offenders,
      viewportOffenders,
      documentOverflow:
        Math.max(doc.scrollWidth, document.body.scrollWidth) > window.innerWidth + 2,
    } satisfies OverlayLayout;
  }, selectors);
}

/**
 * Measure the topmost overlay once it has held still for two reads.
 *
 * A page can mount a popup, lose it to a re-render (a poll tick, a late settings
 * fetch) and mount it again; a single read can land in that gap.
 */
async function measureSettledOverlay(page: Page): Promise<OverlayLayout> {
  let previous = await measureOverlay(page);
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(100);
    const current = await measureOverlay(page);
    if (current.present && previous.present) return current;
    previous = current;
  }
  return previous;
}

/**
 * Assert the overlay contract for the currently open overlay.
 * `label` is used in failure messages (test title + scenario step).
 */
export async function expectOverlayFits(page: Page, label: string): Promise<void> {
  const m = await measureSettledOverlay(page);

  expect(m.present, `${label}: no overlay is open`).toBe(true);
  expect(
    m.scrollWidth,
    `${label}: the overlay scrolls horizontally (${m.scrollWidth}px of content in ${m.clientWidth}px)  content is wider than the modal's bounds`,
  ).toBeLessThanOrEqual(m.clientWidth + 2);
  expect(
    Math.round(m.rect.left),
    `${label}: overlay starts off-screen (left ${Math.round(m.rect.left)}px)`,
  ).toBeGreaterThanOrEqual(-2);
  expect(
    Math.round(m.rect.right),
    `${label}: overlay extends past the viewport (right ${Math.round(m.rect.right)}px > ${m.viewport.width}px)`,
  ).toBeLessThanOrEqual(m.viewport.width + 2);
  expect(
    m.offenders,
    `${label}: content escapes the overlay bounds: ${m.offenders.join(", ")}`,
  ).toEqual([]);
  expect(
    m.viewportOffenders,
    `${label}: content extends past the viewport: ${m.viewportOffenders.join(", ")}`,
  ).toEqual([]);
  expect(
    m.documentOverflow,
    `${label}: the page overflows horizontally while the modal is open`,
  ).toBe(false);
}
