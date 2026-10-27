import { test, expect, type Page } from "@playwright/test";

import { createChatSession, gotoAndSettle, sessionContext, settle } from "./utils";

/**
 * Mobile content-fit guardrails.
 *
 * The overflow suite proves nothing escapes the viewport; this one proves the
 * *content* stays legible at phone widths. Each case is a regression that
 * shipped: a model name squeezed to `De…` by inline badges, a calendar title
 * clipped by its own toolbar, and bottom-nav labels that ellipsized at 320px.
 */

const MOBILE = { width: 375, height: 667 };
const SMALL_PHONE = { width: 320, height: 667 };

const MODEL_LIST_BODY = {
  providers: [
    { id: "deepseek", name: "DeepSeek", modelCount: 1, modelsConfigurable: true },
    { id: "opencode-go", name: "OpenCode Go", modelCount: 2, modelsConfigurable: true },
  ],
  models: {
    deepseek: [
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        reasoning: true,
        vision: true,
        contextWindow: 1000000,
        cost: { input: 1, output: 2 },
      },
    ],
    "opencode-go": [
      {
        id: "deepseek-v4",
        name: "DeepSeek V4",
        reasoning: true,
        vision: true,
        contextWindow: 1000000,
        cost: { input: 1, output: 2 },
      },
      {
        id: "spacex",
        name: "SpaceXAI Grok 5 Preview",
        reasoning: true,
        vision: true,
        contextWindow: 1000000,
        cost: { input: 1, output: 2 },
      },
    ],
  },
  totalModels: 3,
  disabledModels: [],
};

test.describe("mobile content fit", () => {
  test("model names stay readable beside their badges on a phone", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: MOBILE });
    const page = await ctx.newPage();

    // The e2e user has no providers; the list only renders with a stubbed one.
    await page.route("**/api/providers/models*", (route) =>
      route.fulfill({ json: MODEL_LIST_BODY }),
    );
    await page.route(/\/api\/providers(\?.*)?$/, (route) =>
      route.fulfill({
        json: { availableProviders: [], providers: MODEL_LIST_BODY.providers },
      }),
    );

    await gotoAndSettle(page, "/dashboard/settings/models");
    // The inventory lives under a fold, and only the fold's title names it.
    await page.locator('button:has-text("Hide the models you never pick.")').click();
    await expect(page.getByText("DeepSeek Reasoner").first()).toBeVisible();

    // Reveal the list, then measure every rendered (visible) model name.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("*")) {
        const cs = getComputedStyle(el);
        if (
          (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 5
        ) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
    await settle(page);

    const names = await page.evaluate(() =>
      [...document.querySelectorAll("span.truncate.text-sm")]
        .filter((el) => el.clientWidth > 0)
        .map((el) => ({
          text: (el.textContent ?? "").trim(),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
        })),
    );

    expect(names.map((n) => n.text)).toEqual(
      expect.arrayContaining(["DeepSeek Reasoner", "SpaceXAI Grok 5 Preview"]),
    );
    for (const name of names) {
      expect(
        name.scrollWidth,
        `"${name.text}" is truncated at ${MOBILE.width}px (${name.clientWidth}<${name.scrollWidth})`,
      ).toBeLessThanOrEqual(name.clientWidth + 1);
    }

    await ctx.close();
  });

  test("mobile session sheet offers a New Chat action that opens a fresh chat", async ({
    browser,
  }) => {
    const ctx = await sessionContext(browser, { viewport: MOBILE });
    const page = await ctx.newPage();

    // Open an existing session so the header (and its sheet trigger) renders.
    const activeId = await createChatSession(page.request, "E2E content-fit session");

    await gotoAndSettle(page, `/dashboard/chat/${activeId}`);
    await page.getByRole("button", { name: "Open session list" }).first().click();

    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet.getByRole("heading", { name: "Conversations" })).toBeVisible();

    const newChat = sheet.getByRole("button", { name: "New Chat" });
    await expect(newChat).toBeVisible();
    // The button creates the chat before it navigates to it.
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/api/chat/sessions"),
    );
    await newChat.click();
    expect((await created).ok(), "creating the new chat failed").toBe(true);

    await expect(page).toHaveURL(new RegExp(`/dashboard/chat/(?!${activeId}$)[0-9a-f-]{36}$`));
    // The sheet closes with the navigation, not left open over the new chat.
    await expect(sheet).toBeHidden();

    await ctx.close();
  });

  test("the icon bar keeps every item inside its cell on a 320px phone", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: SMALL_PHONE });
    const page = await ctx.newPage();

    // Default 7-item layout is the one that used to squeeze "Calendar".
    await page.request.patch("/api/settings/sidebar-nav", { data: { items: null } });

    await gotoAndSettle(page, "/dashboard/calendar");

    const bar = await page.evaluate(() => {
      const nav = document.querySelector(".mobile-nav");
      if (!nav) return null;
      return {
        height: nav.getBoundingClientRect().height,
        items: [...nav.querySelectorAll("a")].map((link) => {
          const cell = link.getBoundingClientRect();
          const icon = link.querySelector("svg")?.getBoundingClientRect();
          return {
            // The label is gone, so the icon carries the name for a screen reader.
            name: link.getAttribute("aria-label") ?? "",
            squeezed: !icon || icon.width > cell.width || icon.right > cell.right + 0.5,
          };
        }),
      };
    });

    expect(bar, "no bottom bar rendered").not.toBeNull();
    expect(bar!.height, "the bar grew past its 44px row").toBeLessThanOrEqual(45);
    expect(bar!.items.length).toBeGreaterThan(0);
    for (const item of bar!.items) {
      expect(item.name, "a nav item without an accessible name").not.toBe("");
      expect(item.squeezed, `the icon of "${item.name}" does not fit its cell`).toBe(false);
    }

    const calendarTitle = await visibleLabelOverflow(page, "h2");
    const truncatedTitle = calendarTitle.find((l) => /\d{4}/.test(l.text));
    expect(
      truncatedTitle,
      `calendar title truncated: ${JSON.stringify(truncatedTitle)}`,
    ).toBeUndefined();

    await ctx.close();
  });
});

/** Visible elements matching `selector` whose text is ellipsized. */
async function visibleLabelOverflow(page: Page, selector: string) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({
        text: (el.textContent ?? "").trim(),
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }));
  }, selector);
}
