#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Screenshot a route at the widths that matter.
 *
 *   npm run shot -- /dashboard/infra --click "Add Machine"
 *
 * Signs in as the dev account, opens each path at each viewport, runs the
 * clicks in the order they were given, writes one png per pair into
 * `.dev/shots/`, and prints what a layout check looks at: horizontal overflow,
 * body scroll, uncaught page errors.
 *
 * Flags:
 *   --viewport 375,1280   widths to shoot (default 375,1280)
 *   --height 800          viewport height (default 800)
 *   --theme dark          light, dark or system (default system)
 *   --click "<target>"    button label, visible text, or a CSS selector
 *   --wait 600            extra settle time after the last click, in ms
 *   --full-page           screenshot the whole document instead of the window
 *   --out .dev/shots      where the pngs go
 *   --headed              watch it happen
 *
 * Credentials default to the account `scripts/dev.sh setup` seeds
 * (`dev@saale.local`). Override with SHOT_EMAIL / SHOT_PASSWORD.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium, request, type Page } from "@playwright/test";

import { BASE_URL, SHOT_DIR } from "../e2e/env";

const { values, tokens, positionals } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    viewport: { type: "string", default: "375,1280" },
    height: { type: "string", default: "800" },
    theme: { type: "string", default: "system" },
    click: { type: "string", multiple: true },
    wait: { type: "string", default: "600" },
    "full-page": { type: "boolean", default: false },
    out: { type: "string", default: SHOT_DIR },
    headed: { type: "boolean", default: false },
  },
});

if (positionals.length === 0) {
  console.error("usage: npm run shot -- <path> [--click 'Add Machine'] [--viewport 375,1280]");
  process.exit(1);
}

// Read from the tokens, so clicks run in the order they were written.
const clicks: string[] = [];
for (const token of tokens.filter((t) => t.kind === "option")) {
  if (token.name === "click" && token.value) clicks.push(token.value);
}

const viewports = values.viewport.split(",").map((width) => Number(width.trim()));
const height = Number(values.height);
const settleMs = Number(values.wait);

const THEMES = ["light", "dark", "system"] as const;
type Theme = (typeof THEMES)[number];

if (!THEMES.includes(values.theme as Theme)) {
  console.error(`--theme takes ${THEMES.join(", ")}, not "${values.theme}"`);
  process.exit(1);
}

const theme = values.theme as Theme;

/**
 * Click the first visible thing that answers to `target`.
 *
 * A label is what a person sees, but a page action hides its label on a phone
 * and keeps the icon, so the accessible name and a plain selector are tried too.
 */
async function clickStep(page: Page, target: string): Promise<void> {
  const match = page
    .getByRole("button", { name: target })
    .or(page.getByRole("link", { name: target }))
    .or(page.getByText(target))
    .or(page.locator(target))
    .filter({ visible: true })
    .first();
  await match.waitFor({ state: "visible", timeout: 15_000 });
  await match.click();
}

interface LayoutReport {
  width: number;
  scrollWidth: number;
  bodyScrolls: boolean;
  offenders: string[];
}

/**
 * The numbers a visual check cares about, measured in the page.
 *
 * Passed as source text, not as a function: tsx rewrites function bodies with
 * its own helpers, and none of them exist inside the browser.
 */
const MEASURE_LAYOUT = `(() => {
  const innerW = window.innerWidth;
  const doc = document.documentElement;
  const describe = (el) => {
    const cls = typeof el.className === "string" ? "." + el.className.slice(0, 50) : "";
    return el.tagName.toLowerCase() + cls;
  };
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.right <= innerW + 2) continue;
    let parent = el.parentElement;
    let scrollable = false;
    while (parent && parent !== document.body) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        scrollable = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!scrollable) offenders.push(describe(el));
    if (offenders.length >= 5) break;
  }
  return {
    width: innerW,
    scrollWidth: Math.max(doc.scrollWidth, document.body.scrollWidth),
    bodyScrolls: doc.scrollHeight > doc.clientHeight + 2,
    offenders,
  };
})()`;

/** Measure the page, retrying once if a click set a navigation going. */
async function measure(page: Page): Promise<LayoutReport> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await page.evaluate(MEASURE_LAYOUT)) as LayoutReport;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

function slug(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-") || "root";
}

async function main(): Promise<void> {
  const email = process.env.SHOT_EMAIL ?? "dev@saale.local";
  const password = process.env.SHOT_PASSWORD ?? "saale-dev-password";

  const api = await request.newContext({ baseURL: BASE_URL });
  const signIn = await api.post("/api/auth/sign-in/email", { data: { email, password } });
  if (!signIn.ok()) {
    console.error(
      `Signing in as ${email} failed (${signIn.status()}). Run \`sh scripts/dev.sh setup\`, ` +
        `or set SHOT_EMAIL / SHOT_PASSWORD.`,
    );
    process.exit(1);
  }
  const storageState = await api.storageState();
  await api.dispose();

  const browser = await chromium.launch({ headless: !values.headed });
  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });

  const problems: string[] = [];

  for (const width of viewports) {
    for (const pathname of positionals) {
      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: { width, height },
        deviceScaleFactor: 2,
        storageState,
        ...(theme === "system" ? {} : { colorScheme: theme }),
      });
      // next-themes reads its stored choice before the first paint, so this has
      // to land before the document does.
      if (theme !== "system") {
        await context.addInitScript(`localStorage.setItem("theme", ${JSON.stringify(theme)})`);
      }
      const page = await context.newPage();

      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      try {
        await page.goto(pathname, { waitUntil: "domcontentloaded" });
        await page.locator("main").first().waitFor({ state: "visible", timeout: 20_000 });
        await page.evaluate("document.fonts.ready");
        for (const target of clicks) await clickStep(page, target);
        if (settleMs > 0) await page.waitForTimeout(settleMs);

        const file = path.join(outDir, `${slug(pathname)}-${width}.png`);
        // The dev overlay is a badge pinned over the page, not part of the app.
        await page.evaluate(
          "document.querySelectorAll('nextjs-portal').forEach((el) => el.remove())",
        );
        await page.screenshot({ path: file, fullPage: values["full-page"] });

        const layout = await measure(page);
        console.log(
          `${path.relative(process.cwd(), file)} · ${width}px · ` +
            `scrollWidth ${layout.scrollWidth}/${layout.width} · ` +
            `body scrolls: ${layout.bodyScrolls ? "YES" : "no"}`,
        );
        if (layout.offenders.length > 0) {
          const line = `${pathname} @ ${width}px: past the viewport: ${layout.offenders.join(", ")}`;
          problems.push(line);
          console.log(`  ! ${line}`);
        }
        for (const error of errors.slice(0, 5)) {
          console.log(`  ! ${error}`);
          problems.push(`${pathname} @ ${width}px: ${error}`);
        }
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();

  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s) on screen.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
