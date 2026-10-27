import { test } from "@playwright/test";

import { MODAL_SCENARIOS } from "./modal-scenarios";
import { expectOverlayFits, waitForOverlay } from "./overlay-layout";
import { VIEWPORTS, gotoAndSettle, sessionContext } from "./utils";

/**
 * Modal layout guardrails.
 *
 * Opens every overlay in the app at phone widths and enforces the overlay
 * contract from `overlay-layout.ts`: a modal must fit its bounds and must never
 * scroll horizontally. A long unbreakable key/URL/token inflating an auto-width
 * grid track (the "Setup SSH Access" regression) fails these tests.
 *
 * New overlays are picked up automatically: `__tests__/overlay-coverage.test.ts`
 * fails when a component renders a modal that isn't registered in
 * `modal-scenarios.ts`.
 */

test.describe("modal layout guardrails", () => {
  for (const { name, width, height } of VIEWPORTS) {
    for (const scenario of MODAL_SCENARIOS) {
      const title = `${scenario.name} @ ${name}`;

      if (scenario.skip) {
        test.skip(`${title}  ${scenario.skip}`, () => {});
        continue;
      }

      test(title, async ({ browser }) => {
        const ctx = await sessionContext(browser, { viewport: { width, height } });
        const page = await ctx.newPage();

        try {
          await scenario.mock?.(page);
          await gotoAndSettle(page, scenario.path);
          await scenario.open!(page);
          await waitForOverlay(page);
          await expectOverlayFits(page, title);
        } finally {
          await ctx.close();
        }
      });
    }
  }
});
