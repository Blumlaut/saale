import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

import { VIEWPORTS, bootstrapSession, type E2ESession } from "./utils";

/**
 * File drag & drop on the chat.
 *
 * Files reach the composer three ways — the paperclip, a paste, and a drop.
 * The drop is the only one that takes the whole view, so it is the only one
 * worth checking in a browser: the drop has to be *claimed* (an unhandled file
 * drop navigates the tab to the file), the hint has to appear while the drag
 * is over the chat and fit at phone widths, and the dropped file has to land
 * in the same pending strip the paperclip fills.
 */

let session: E2ESession | null = null;
let sessionId = "";

const DROP_HINT = "Drop files to attach";
const COMPOSER = 'textarea[placeholder="Message Saale..."]';
const DROP_ZONE = '[data-slot="chat-drop-zone"]';

/** The app renders a desktop and a mobile shell — only one is ever visible. */
function visible(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}

/** Create a chat session to open — the chat layout only renders with one. */
async function createSession(browser: Browser): Promise<string> {
  const ctx = await browser.newContext({ storageState: session!.storageState });
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });
    const res = await page.request.post("/api/chat/sessions", {
      data: { title: "file drop guardrail" },
    });
    expect(res.ok(), `creating a chat session failed (${res.status()})`).toBe(true);
    const body = (await res.json()) as { session?: { id?: string } };
    return body.session?.id ?? "";
  } finally {
    await ctx.close();
  }
}

async function openChat(browser: Browser, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, storageState: session!.storageState });
  const page = await ctx.newPage();
  await page.goto(`/dashboard/chat/${sessionId}`, { waitUntil: "domcontentloaded" });
  await visible(page, DROP_ZONE).waitFor({ state: "visible", timeout: 20_000 });
  await visible(page, COMPOSER).waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}

/** A real `DataTransfer` holding one file, built in the page. */
async function fileTransfer(page: Page, name: string, type: string) {
  return page.evaluateHandle(
    ([fileName, fileType]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped"], fileName!, { type: fileType! }));
      return transfer;
    },
    [name, type],
  );
}

/** Drag a file over `target` — the chat column, or anything inside it. */
async function dragFileOver(page: Page, target: Locator, name: string, type: string) {
  const dataTransfer = await fileTransfer(page, name, type);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  return dataTransfer;
}

test.describe("chat file drop", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ browser, request }) => {
    session = await bootstrapSession(browser, request);
    sessionId = await createSession(browser);
  });

  for (const { name, width, height } of VIEWPORTS) {
    test(`a dropped file is staged in the composer @ ${name}`, async ({ browser }) => {
      test.skip(!sessionId, "could not create a chat session");
      const { ctx, page } = await openChat(browser, { width, height });

      try {
        // Dragged over the chat column.
        const zone = visible(page, DROP_ZONE);
        const dataTransfer = await dragFileOver(
          page,
          zone,
          "quarterly-report.pdf",
          "application/pdf",
        );

        await expect(page.getByText(DROP_HINT)).toBeVisible();

        // The hint covers the drop zone exactly, and widens nothing: a
        // full-bleed view that suddenly scrolls sideways is a regression.
        const geometry = await page.evaluate(() => {
          // Both shells render this markup — only one of them is laid out.
          const laidOut = (selector: string) =>
            [...document.querySelectorAll<HTMLElement>(selector)].find(
              (el) => el.getBoundingClientRect().width > 0,
            ) ?? null;
          const box = laidOut('[data-slot="file-drop-overlay"]');
          const zone = laidOut('[data-slot="chat-drop-zone"]');
          if (!box || !zone) return null;
          const a = box.getBoundingClientRect();
          const b = zone.getBoundingClientRect();
          return {
            hint: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
            zone: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
            clientWidth: box.clientWidth,
            scrollWidth: box.scrollWidth,
            viewportWidth: window.innerWidth,
          };
        });
        expect(geometry, "the drop hint did not render").not.toBeNull();
        expect(geometry!.scrollWidth).toBeLessThanOrEqual(geometry!.clientWidth + 1);
        expect(geometry!.hint.left).toBeCloseTo(geometry!.zone.left, 0);
        expect(geometry!.hint.right).toBeCloseTo(geometry!.zone.right, 0);
        expect(geometry!.hint.top).toBeCloseTo(geometry!.zone.top, 0);
        expect(geometry!.hint.bottom).toBeCloseTo(geometry!.zone.bottom, 0);
        expect(geometry!.hint.right).toBeLessThanOrEqual(geometry!.viewportWidth + 1);

        // Dropped on the composer itself.
        await visible(page, COMPOSER).dispatchEvent("drop", { dataTransfer });

        await expect(page.getByText(DROP_HINT)).toBeHidden();
        await expect(page.getByText("quarterly-report.pdf")).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Remove quarterly-report.pdf" }),
        ).toBeVisible();
      } finally {
        await ctx.close();
      }
    });
  }

  test("previews an image, and leaves a text drag alone", async ({ browser }) => {
    test.skip(!sessionId, "could not create a chat session");
    const { ctx, page } = await openChat(browser, { width: 1280, height: 800 });

    try {
      const composer = visible(page, COMPOSER);

      // A text drag advertises no files: the chat must not claim it.
      await composer.dispatchEvent("dragenter", {
        dataTransfer: await page.evaluateHandle(() => {
          const transfer = new DataTransfer();
          transfer.setData("text/plain", "some selected text");
          return transfer;
        }),
      });
      await expect(page.getByText(DROP_HINT)).toBeHidden();

      const dataTransfer = await dragFileOver(page, composer, "screenshot.png", "image/png");
      await expect(page.getByText(DROP_HINT)).toBeVisible();
      await composer.dispatchEvent("drop", { dataTransfer });

      await expect(page.getByAltText("screenshot.png")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
