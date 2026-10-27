---
name: e2e-testing
description: Running and writing Saale's Playwright suite, and getting a visual look at a page or overlay without building a harness. Use when you need to check a panel/route/modal at a phone width, add or fix an e2e spec, debug a flaky e2e test, or run the suite. Not for unit tests (vitest) or backend-only changes.
---

# E2E Testing

Playwright lives in `e2e/`, driven by `playwright.config.ts`. Unit tests are a
different tool: `__tests__` under vitest, fast and DB-free. Reach for e2e only
for what a unit test cannot see: layout at a real viewport, hydration, gestures,
auth and cookies, real HTTP.

## Look at a page first, write a spec second

Most requests are "does this panel look right?". Do not build a spec for it.

```bash
npm run shot -- /dashboard/infra --click "Add Machine"
npm run shot -- /dashboard/settings/models --viewport 375,320,1280
npm run shot -- /dashboard/chat --click "New Chat" --full-page
```

`scripts/shot.ts` signs in as the dev account (`dev@saale.local`), opens each
path at each viewport, runs `--click` steps in order, writes `.dev/shots/<path>-<width>.png`
and prints what a layout check looks at: `scrollWidth/innerWidth`, whether the
body scrolls, elements past the right edge, and page/console errors. It reuses
the checkout's dev server, so it is up in seconds.

- `--click "<target>"` takes a button label, visible text or a CSS selector, and
  finds the _visible_ copy (the app renders one DOM for every shell).
- Read the png. Show it to the user with the file tool when they asked to see it.
- Overflow numbers in the output are a warning, not a verdict: a clipped
  element inside its own scroller is fine.

Credentials: `dev@saale.local` / `saale-dev-password` (what `scripts/dev.sh setup`
seeds). Set `SHOT_EMAIL` / `SHOT_PASSWORD` to look as someone else.

## Running the suite

```bash
npm run test:e2e                        # full run, production build (default)
npm run test:e2e:dev                    # full run against the dev server
npx playwright test e2e/modal-overflow.spec.ts -g "infra · add machine"
npx playwright test e2e/mobile-overflow.spec.ts --headed
npx playwright test --last-failed
```

A full run is ~3 minutes. What makes it fast:

- **The server.** `playwright.config.ts` points at this checkout's port (the
  one in `.env`, written by `scripts/dev.sh`), and `scripts/e2e-server.sh`
  builds a production bundle into `.next-e2e` when the source is newer than the
  last build, then serves it. A dev server compiles each route on its first
  hit, which is where the ten extra minutes used to go. `E2E_SERVER=dev` keeps
  a dev server instead.
- **Whatever already answers wins.** `reuseExistingServer` means a dev server
  you are already running is used as-is. Confirm which one you got from the
  run's speed, or stop the dev server first.
- **One session per run.** `e2e/global-setup.ts` signs the shared user in, grants
  it the admin role, seeds the stress fixtures and writes `.playwright/e2e-session.json`;
  `use.storageState` hands that to every context. Never sign in inside a spec.
- **Four workers.** More workers against the same server queue behind each
  other. `workers` in the config is not a knob to raise casually.

A dev server is for one file at a time (`E2E_SERVER=dev`, or just reuse the dev
server you have open). Under four workers it compiles routes on demand and a
client-side transition can take seconds; the suite is tuned for the built
server, so judge a full run by the default command.

`BASE_URL` overrides the target (a preview, a deployment). Then the app under
test must share this checkout's database or the admin grant fails loudly on
purpose.

## Writing a spec

Start from the shape the existing files use:

```ts
import { test, expect } from "@playwright/test";

import { createChatSession, gotoAndSettle, sessionContext, settle } from "./utils";

test.describe("what this guards", () => {
  test("a specific, observable claim", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    try {
      const response = await gotoAndSettle(page, "/dashboard/infra");
      expect(response?.status()).toBeLessThan(400);
      // web-first assertions only
      await expect(page.getByRole("button", { name: "Add Machine" })).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
```

Rules that keep a run fast and honest:

- **You are already signed in.** `browser.newContext()` does _not_ inherit
  `use.storageState`, so pick your viewport through `sessionContext(browser, { viewport })`.
  The default `page`/`context`/`request` fixtures are signed in too.
- **`gotoAndSettle` instead of `page.goto`.** It waits for `load` (the point
  where hydration has happened, so clicks actually do something), the shell,
  the fonts that decide text widths, and two frames. Add `{ quietNetwork: true }`
  when the assertion depends on data fetched after paint; it is capped at 2s
  because a page with a poll or an SSE stream never goes idle.
- **No `waitForTimeout` for state.** Use `expect.poll`, `expect(...).toBeVisible()`,
  `locator.waitFor`, `waitForResponse`, or wait for the effect itself (fonts,
  an overlay's entry animation). A fixed sleep is either too short (flaky) or
  too long (slow), usually both.
- **Mock the API, do not drive it.** `page.route` before navigating. Model calls,
  sandboxes, IMAP and Telegram are not part of a layout test. See
  `e2e/council-mocks.ts` and the `mock*` helpers in `e2e/modal-scenarios.ts`.
- **Create fixtures over HTTP.** `page.request.post("/api/chat/sessions")`, not
  three clicks through the UI. Shared helpers: `createChatSession`,
  `discardChatSessions`.
- **Clean up what you create** in `finally`/`afterAll`, and never delete what you
  did not create.
- **One navigation per test** where possible. Each context costs a compile on a
  dev server and a full page load everywhere.

## The guardrail suites

These three exist so a UI change cannot silently break a phone layout:

| Suite                     | What it proves                                                          |
| ------------------------- | ----------------------------------------------------------------------- |
| `mobile-overflow.spec.ts` | every route renders at 375px and 320px, no body scroll, nothing escapes |
| `modal-overflow.spec.ts`  | every overlay fits its bounds and never scrolls horizontally            |
| `page-actions.spec.ts`    | every page's action row sits in the first panel at one height           |

Adding a route or a page action means adding it to the `PAGES` list in that
spec. Adding an overlay means adding a `ModalScenario` to `e2e/modal-scenarios.ts`:
name, route, `sources`, an `open(page)` that ends with the overlay on screen,
and a `mock` if the app cannot reach that state with fixtures. `skipped` scenarios
need a reason. `__tests__/overlay-coverage.test.ts` fails when a component renders
a `DialogContent`/`SheetContent` that has no entry.

## Flake rules

- A flaky test is a bug in the test or in the app. Do not paper over it with a
  longer timeout or a retry.
- Measure after the thing you measure has settled: fonts for text width, the
  overlay's entry animation for a modal box, `expect.poll` for anything animated.
- Pick the _visible_ copy of an element. The app renders one DOM and hides a
  shell with CSS, so `.first()` can select a different copy than the one on
  screen. `page.locator(sel).filter({ visible: true }).first()`, or `:visible`.
- Fixtures go stale. When an app type gains a field, a mock that omits it crashes
  the page under test and the failure looks like a layout bug ("Something went
  wrong"). Read the page's error, not the assertion.
- If two tests share state on the shared user (sidebar layout, settings), the
  file runs `mode: "serial"` and resets in `beforeEach`.
- `429` in a run is the app rate-limiting itself per IP and path; the e2e server
  raises both limits (`scripts/e2e-server.sh`). A spec that hits 429 elsewhere is
  sending far more requests than it needs.

## Debugging

```bash
npx playwright test <file> --headed            # watch it
npx playwright test <file> --grep "<title>" -x # stop at the first failure
npx playwright show-trace test-results/**/trace.zip
```

`trace: "on-first-retry"` and `screenshot: "only-on-failure"` are on: a failed
test leaves a screenshot and a trace under `test-results/`. The trace's console
tab is where a client-side crash shows its stack (`error-context.md` shows the
page too).

## CI

`.github/workflows/checks.yml` does not run e2e: it needs Postgres, Redis and a
build. Run the suite locally before merging a UI change; that is the contract.
