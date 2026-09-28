import { test, expect } from "@playwright/test";

import { bootstrapSession, gotoAndSettle, type E2ESession } from "./utils";

/**
 * Model picker overflow guardrail.
 *
 * The model list is capped at 320px (`ScrollArea max-h-[320px]`) and must scroll
 * *inside* the popover. If the ScrollArea regresses (e.g. its viewport stops
 * being clamped), a long model list overflows past the popover's bottom edge
 * and the last options render outside the dropdown bounds.
 *
 * The models endpoint is mocked so the picker renders a list tall enough to
 * exceed the cap, without needing a provider configured for the e2e user.
 */

const MODEL_COUNT = 15;
const MAX_LIST_PX = 320;

function mockModelsResponse() {
  const models = {
    custom: Array.from({ length: MODEL_COUNT }, (_, i) => ({
      id: `e2e-model-${i}`,
      name: `E2E Model ${i}`,
      reasoning: false,
      vision: false,
    })),
  };
  return {
    providers: [
      { id: "custom", name: "Custom", modelCount: MODEL_COUNT, modelsConfigurable: true },
    ],
    models,
    totalModels: MODEL_COUNT,
    disabledModels: [],
  };
}

let session: E2ESession | null = null;

test.describe("Model picker overflow", () => {
  // Bootstrap logs in and seeds fixtures — slower than a single page visit.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ browser, request }) => {
    session = await bootstrapSession(browser, request);
  });

  test("long model list scrolls inside the popover, never past its bounds", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 667 },
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();

    // Intercept the models fetch so the picker renders an overflowing list
    // regardless of the e2e user's configured providers.
    await page.route("**/api/providers/models*", (route) =>
      route.fulfill({ json: mockModelsResponse() }),
    );

    // The header's model picker only renders for an active session — reuse an
    // existing one or seed it (idempotent, so repeated runs don't accumulate).
    const TITLE = "E2E model picker overflow";
    let sessionId: string | undefined;
    const list = await page.request.get("/api/chat/sessions");
    if (list.ok()) {
      const { sessions } = (await list.json()) as {
        sessions: Array<{ id: string; title: string }>;
      };
      sessionId = sessions.find((s) => s.title === TITLE)?.id;
    }
    if (!sessionId) {
      const created = await page.request.post("/api/chat/sessions", { data: { title: TITLE } });
      expect(created.ok()).toBeTruthy();
      const { session } = (await created.json()) as { session: { id: string } };
      sessionId = session.id;
    }

    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);

    // Mobile: open the ⚙️ header dropdown, then the model picker inside it.
    // The page mounts the mobile and desktop shells, so the gear trigger
    // exists in duplicate (one hidden) — filter to the visible instance.
    const gear = page
      .locator('[data-slot="dropdown-menu-trigger"]:visible')
      .filter({ has: page.locator(".lucide-settings-2") })
      .first();
    await gear.waitFor({ state: "visible", timeout: 15_000 });
    await gear.click();

    const pickerTrigger = page
      .locator('[data-slot="dropdown-menu-content"]')
      .filter({ has: page.locator(".lucide-brain") })
      .first()
      .locator(".lucide-brain");
    // The picker mounts when the dropdown opens and shows a spinner until the
    // (mocked) models load; the brain icon only appears once loaded.
    await pickerTrigger.waitFor({ state: "visible", timeout: 15_000 });
    await pickerTrigger.click();

    const popover = page.locator('[data-slot="popover-content"]').first();
    await popover.locator('input[placeholder="Search models..."]').waitFor({ state: "visible" });
    await page.waitForTimeout(300); // let layout settle

    const viewport = popover.locator('[data-slot="scroll-area-viewport"]');
    const optionCount = await viewport.locator("button").count();
    expect(optionCount).toBe(MODEL_COUNT);

    const popBox = (await popover.boundingBox())!;
    const vpBox = (await viewport.boundingBox())!;
    const { clientHeight, scrollHeight } = await viewport.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));

    // The list is tall enough that it *would* overflow the 320px cap…
    expect(scrollHeight).toBeGreaterThan(MAX_LIST_PX);
    // …so the viewport must be clamped and scroll internally.
    expect(clientHeight).toBeLessThanOrEqual(MAX_LIST_PX);
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // The viewport stays inside the popover, and the popover stays in the window.
    expect(vpBox.y).toBeGreaterThanOrEqual(popBox.y - 1);
    expect(vpBox.y + vpBox.height).toBeLessThanOrEqual(popBox.y + popBox.height + 1);
    expect(popBox.y).toBeGreaterThanOrEqual(0);
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(667);
    expect(popBox.x).toBeGreaterThanOrEqual(0);
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(375);

    // The last option must be reachable by scrolling and remain inside the
    // viewport — not rendered past the popover's bottom edge.
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    const lastOption = viewport.locator("button").last();
    const lastBox = (await lastOption.boundingBox())!;
    expect(lastBox.y).toBeGreaterThanOrEqual(vpBox.y - 1);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(vpBox.y + vpBox.height + 1);

    await ctx.close();
  });
});
