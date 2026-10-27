import { test, expect, type Page } from "@playwright/test";

import { VIEWPORTS, gotoAndSettle, sessionContext } from "./utils";
import { COUNCIL_ROUTES, mockCouncilWorkspace } from "./council-mocks";

/**
 * Mobile layout guardrails.
 *
 * Runs every dashboard/admin route at phone widths and asserts the app-shell
 * contract from AGENTS.md ("No External Scroll"):
 *
 *   1. The body/viewport never scrolls  all scrolling is internal.
 *   2. No element may extend past the right edge of the viewport unless it is
 *      contained by a scrollable ancestor (e.g. a swipe-scrollable tab strip).
 *   3. Visible tab strips must never be squeezed  triggers overflowing their
 *      own list means labels overlap and clip (the classic `w-full` tab bug).
 *   4. Content taller than the viewport must be reachable: after scrolling
 *      every internal scroll container, the last interactive element must be
 *      visible. A page without an internal scroll container fails this check.
 *
 * The suite runs against long-named content seeded through the real API
 * (`global-setup.ts`), so the layout is exercised with data that *would*
 * overflow if truncation/min-w-0 handling regressed.
 */

const DASHBOARD_PAGES = [
  "/dashboard/chat",
  "/dashboard/coder",
  "/dashboard/mail",
  "/dashboard/contacts",
  "/dashboard/calendar",
  "/dashboard/tasks",
  "/dashboard/jobs",
  "/dashboard/jobs/watchers",
  "/dashboard/infra",
  "/dashboard/settings",
];

const ADMIN_PAGES = [
  "/admin/models/providers",
  "/admin/models/availability",
  "/admin/plugins/logs",
  "/admin/users",
  "/admin/roles",
  "/admin/plugins",
  "/admin/settings",
];

/**
 * Every route this spec measures: the dashboard, the councils (whose API is
 * mocked  a council run costs model calls and measures nothing extra) and the
 * admin pages.
 */
const PAGES: { path: string; prepare?: (page: Page) => Promise<void> }[] = [
  ...DASHBOARD_PAGES.map((path) => ({ path })),
  ...COUNCIL_ROUTES.map((path) => ({ path, prepare: mockCouncilWorkspace })),
  ...ADMIN_PAGES.map((path) => ({ path })),
];

interface LayoutViolations {
  documentOverflow: boolean;
  offenders: string[];
  squeezedTabStrips: number;
  bodyScrolls: boolean;
  lastElementReachable: boolean;
  lastElementLabel: string | null;
  measured?: boolean;
}

async function measureLayout(page: Page): Promise<LayoutViolations> {
  return page.evaluate(() => {
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const doc = document.documentElement;

    const result: LayoutViolations = {
      documentOverflow: false,
      offenders: [],
      squeezedTabStrips: 0,
      bodyScrolls: false,
      lastElementReachable: true,
      lastElementLabel: null,
    };

    // 1. Document-level horizontal overflow (the shell clips, so scrollWidth
    //    alone misses clipped overflow  still worth asserting).
    result.documentOverflow = Math.max(doc.scrollWidth, document.body.scrollWidth) > innerW + 2;

    // 2. Elements extending past the right edge, unless contained by a
    //    scrollable ancestor (swipe-scrollable tab strips etc.).
    const isInsideScrollable = (el: Element): boolean => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") return true;
        p = p.parentElement;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerW + 2 && !isInsideScrollable(el)) {
        const cls = typeof el.className === "string" ? el.className : "";
        offenders.push(`${el.tagName.toLowerCase()}.${cls.slice(0, 40)}`);
        if (offenders.length >= 5) break;
      }
    }
    result.offenders = offenders;

    // 3. Visible tab strips must not be squeezed (scrollWidth > clientWidth
    //    means triggers overflow their own list → overlapping labels).
    //    base-ui renders a hidden measurement copy  ignore zero-size lists.
    result.squeezedTabStrips = [...document.querySelectorAll('[data-slot="tabs-list"]')].filter(
      (l) => {
        const r = l.getBoundingClientRect();
        return r.width > 0 && l.scrollWidth > l.clientWidth + 2;
      },
    ).length;

    // 4. The body must never scroll  scrolling is internal to panels.
    result.bodyScrolls = doc.scrollHeight > doc.clientHeight + 2;

    // 5. Reachability: scroll every internal scroll container to the bottom and
    //    confirm the last interactive element is fully visible. Pages whose
    //    content is clipped by an overflow-hidden ancestor without an internal
    //    scroll container fail here.
    const main = [...document.querySelectorAll("main")].find(
      (m) => m.getBoundingClientRect().width > 0,
    );
    if (main) {
      for (const el of main.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (
          (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 5
        ) {
          el.scrollTop = el.scrollHeight;
        }
      }
      const interactives = [
        ...main.querySelectorAll("button, a, input, textarea, [role='tab']"),
      ].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const last = interactives[interactives.length - 1];
      if (last) {
        const r = last.getBoundingClientRect();
        result.lastElementLabel = (last.textContent ?? last.tagName).trim().slice(0, 40);
        result.lastElementReachable = r.top >= -2 && r.bottom <= innerH + 2;
      }
    }

    return result;
  });
}

test.describe("mobile layout guardrails", () => {
  for (const { name, width, height } of VIEWPORTS) {
    for (const { path, prepare } of PAGES) {
      test(`${path} @ ${name}`, async ({ browser }) => {
        const ctx = await sessionContext(browser, { viewport: { width, height } });
        const page = await ctx.newPage();

        try {
          await prepare?.(page);
          const response = await gotoAndSettle(page, path, { quietNetwork: true });

          // A shell that throws in render still satisfies every measurement
          // below the error boundary is a well-behaved full-height panel. That
          // is how /admin/* shipped broken (missing sidebar provider → 500), so
          // assert the route itself rendered, and that nothing bounced us
          // elsewhere.
          expect(response?.status(), `${path}: responded ${response?.status()}`).toBeLessThan(400);
          expect(page.url(), `${path}: landed on ${page.url()}`).toContain(path);
          await expect(page.getByText("Something went wrong")).toHaveCount(0);

          const v = await measureLayout(page);

          expect(v.documentOverflow, `${path}: document overflows horizontally`).toBe(false);
          expect(
            v.offenders,
            `${path}: elements extend past viewport: ${v.offenders.join(", ")}`,
          ).toEqual([]);
          expect(v.squeezedTabStrips, `${path}: tab strip triggers are squeezed/overlapping`).toBe(
            0,
          );
          expect(v.bodyScrolls, `${path}: body scrolls  content must scroll inside a panel`).toBe(
            false,
          );
          expect(
            v.lastElementReachable,
            `${path}: last interactive element (${v.lastElementLabel}) unreachable  page lacks an internal scroll container`,
          ).toBe(true);
        } finally {
          await ctx.close();
        }
      });
    }
  }
});
