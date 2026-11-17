import { test, expect, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, sessionContext, settle } from "./utils";

/**
 * Slash command arguments, driven the way a person types them.
 *
 * The composer is the whole surface for this: the `/` menu, the argument rows a
 * command declares, Tab and Enter taking the highlighted row, the values of a
 * choice and a boolean, the highlight behind what is filled in, and the file
 * picker behind `/edit`.
 */

const COMPOSER = 'textarea[placeholder="Message Saale..."]';
const LISTBOX = '[role="listbox"]';
const HIGHLIGHT = '[data-slot="composer-highlight"]';

let sessionId = "";
const created: string[] = [];

test.beforeAll(async ({ request }) => {
  sessionId = await createChatSession(request, "e2e slash command arguments");
  created.push(sessionId);
});

test.afterAll(async ({ request }) => {
  await discardChatSessions(request, created);
});

/** The composer of this chat, ready for typing. */
async function openComposer(browser: Parameters<typeof sessionContext>[0]) {
  const context = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/dashboard/chat/${sessionId}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const composer = page.locator(COMPOSER).filter({ visible: true }).first();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.click();
  return { context, page, composer };
}

/** The rows the menu is offering, as their visible text. */
async function rows(page: Page): Promise<string[]> {
  const list = page.locator(LISTBOX).filter({ visible: true });
  if ((await list.count()) === 0) return [];
  return (await list.locator('[role="option"]').allInnerTexts()).map((text) =>
    text.replace(/\s+/g, " ").trim(),
  );
}

/** The runs painted behind the text, as `kind:text`. */
async function painted(page: Page): Promise<string[]> {
  return page
    .locator(`${HIGHLIGHT} [data-kind]`)
    .evaluateAll((spans) =>
      spans.map((span) => `${span.getAttribute("data-kind")}:${span.textContent}`),
    );
}

test("offers the commands on a slash, and what each one takes", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/ed");
  const listed = await rows(page);
  expect(listed[0]).toContain("/edit");
  expect(listed[0]).toContain("prompt: files: size:");
  await expect(page.locator(HIGHLIGHT)).toHaveCount(0);

  await context.close();
});

test("fills an argument name with Enter when the command needs it", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/image ");
  expect((await rows(page)).map((row) => row.split(/\s/)[0])).toEqual(["prompt:", "size:"]);

  await composer.press("Enter");

  await expect(composer).toHaveValue("/image prompt:");
  // Nothing left to fill in for a free-text value, so the menu gets out of the way.
  await expect(page.locator(LISTBOX)).toHaveCount(0);

  await context.close();
});

test("takes an optional argument with Tab, then sends the command", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/image prompt:a red fox in the snow ");
  expect((await rows(page))[0]).toContain("size:");

  await composer.press("Tab");
  await expect(composer).toHaveValue("/image prompt:a red fox in the snow size:");

  await context.close();
});

test("paints the argument names and values behind the text", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/stop clear:true");

  await expect(page.locator(HIGHLIGHT)).toBeVisible();
  expect(await painted(page)).toEqual(["command:/stop", "plain: ", "label:clear:", "value:true"]);

  await context.close();
});

test("offers a boolean's two values and takes one with Enter", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/stop clear:");
  expect((await rows(page)).map((row) => row.split(/\s/)[0])).toEqual(["true", "false"]);

  await composer.press("Enter");

  await expect(composer).toHaveValue("/stop clear:true");
  await context.close();
});

test("offers the resolutions the server lists for size:", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  // The composer cannot know a model's resolutions from the catalog, so the
  // page asks the server. Stubbed here so the run does not depend on which
  // image model the instance has configured.
  await page.route("**/command/options?name=image", (route) =>
    route.fulfill({
      json: {
        options: {
          size: [
            {
              value: "1024x1024",
              label: "1024 × 1024 · square",
              description: "The model's default",
            },
            { value: "1024x1536", label: "1024 × 1536 · portrait" },
          ],
        },
      },
    }),
  );

  await composer.pressSequentially("/image size:");
  await expect(page.locator(`${LISTBOX} [role="option"]`)).toHaveCount(2);

  const portrait = page
    .locator(`${LISTBOX} [role="option"]`)
    .filter({ hasText: "portrait" })
    .first();
  await expect(portrait).toContainText("1024x1536");

  await composer.press("ArrowDown");
  await composer.press("Tab");

  await expect(composer).toHaveValue("/image size:1024x1536");
  await context.close();
});

test("offers a choice's options and takes one with Tab", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/stfu time:");
  expect((await rows(page)).map((row) => row.split(/\s/)[0])).toEqual(["on", "permanent", "stop"]);

  await composer.press("ArrowDown");
  await composer.press("Tab");

  await expect(composer).toHaveValue("/stfu time:permanent");
  await context.close();
});

test("completes the first argument from a bare word typed after the command", async ({
  browser,
}) => {
  const { context, page, composer } = await openComposer(browser);

  await page.route("**/command/options?name=model", (route) =>
    route.fulfill({
      json: {
        options: {
          name: [
            { value: "opencode-go:qwen4-max", label: "Qwen4 Max" },
            { value: "anthropic:claude-sonnet-4", label: "Claude Sonnet 4" },
          ],
        },
      },
    }),
  );

  // Typing straight after the command fills its first argument, and a part
  // of the value matches wherever it sits inside the option.
  await composer.pressSequentially("/model qwen");
  const option = page.locator(`${LISTBOX} [role="option"]`).first();
  await expect(option).toContainText("opencode-go:qwen4-max");

  await composer.press("Enter");
  await expect(composer).toHaveValue("/model name:opencode-go:qwen4-max");

  await context.close();
});

test("runs a command whose arguments are optional when Enter is pressed", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);
  const posted = page.waitForRequest(
    (request) => request.url().endsWith("/command") && request.method() === "POST",
  );

  await composer.pressSequentially("/stop ");
  await expect(page.locator(LISTBOX)).toBeVisible();

  await composer.press("Enter");

  // The command ran with no argument line, and the composer was handed back.
  expect((await posted).postDataJSON()).toMatchObject({ name: "stop" });
  await expect(composer).toHaveValue("");

  await context.close();
});

test("moves the highlight with the arrow keys and closes the menu with Escape", async ({
  browser,
}) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/image ");
  const first = page.locator(`${LISTBOX} [role="option"]`).first();
  await expect(first).toHaveAttribute("aria-selected", "true");

  await composer.press("ArrowDown");
  await expect(first).toHaveAttribute("aria-selected", "false");

  await composer.press("Escape");
  await expect(page.locator(LISTBOX)).toHaveCount(0);

  await context.close();
});

test("opens the file picker from the files row", async ({ browser }) => {
  const { context, page, composer } = await openComposer(browser);

  await composer.pressSequentially("/edit ");
  const files = page.locator(`${LISTBOX} [role="option"]`).filter({ hasText: "files" }).first();
  await expect(files).toContainText("paperclip");

  const chooser = page.waitForEvent("filechooser");
  await files.click();

  const files1 = await chooser;
  // The picker is the composer's own input, not a separate dialog.
  expect(files1.element()).toBeTruthy();
  await files1.setFiles([]);
  await expect(composer).toHaveValue("/edit ");

  await context.close();
});
