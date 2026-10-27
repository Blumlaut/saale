import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

import { SESSION_FILE } from "./env";

/** The account every suite runs as. Created and seeded by `global-setup.ts`. */
export const E2E_EMAIL = "e2e-mobile@saale.local";
export const E2E_USERNAME = "e2e-mobile";
export const E2E_PASSWORD = "TestPass123!";

/** Phone widths the layout guardrails run at  see AGENTS.md "Mobile-First Layouts". */
export const VIEWPORTS = [
  { name: "375px", width: 375, height: 667 }, // iPhone SE
  { name: "320px", width: 320, height: 667 }, // smallest common phone
];

/** The page region every dashboard and admin route renders into. */
const SHELL = "main";

export type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

/**
 * A context carrying the signed-in session.
 *
 * `browser.newContext()` does not inherit `use.storageState`, only the built-in
 * `context`/`page` fixtures do  specs that pick their own viewport call this.
 */
export function sessionContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: SESSION_FILE });
}

/** Sign the suite's user up. An existing user is fine (any non-2xx is ignored). */
export async function ensureUser(request: APIRequestContext): Promise<void> {
  await request.post("/api/auth/sign-up/email", {
    data: {
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
      name: E2E_USERNAME,
      username: E2E_USERNAME,
    },
  });
}

/**
 * Sign in through the API and keep the cookies.
 *
 * The UI form would cost a navigation and a compile of the login route for the
 * same cookie. `login()` stays for the specs that drive the form on purpose.
 */
export async function signIn(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(`e2e: sign-in failed (${response.status()})  did global setup run?`);
  }
}

/** Log the shared e2e user in and wait for the dashboard shell. */
export async function login(page: Page): Promise<void> {
  await page.goto("/auth/login");
  await page.fill('input[name="username"]', E2E_USERNAME);
  await page.fill('input[name="password"]', E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard/**", { timeout: 20_000 });
}

/**
 * Seed long-named content through the real API so truncation / `min-w-0`
 * handling is exercised with data that *would* overflow if it regressed.
 * Idempotent: existing rows are detected up front, so repeat runs stay quiet.
 */
export async function seedStressData(request: APIRequestContext): Promise<void> {
  const seeds: SeedSpec[] = [
    {
      label: "agent job",
      listUrl: "/api/agent-jobs/definitions",
      listKey: "definitions",
      createUrl: "/api/agent-jobs/definitions",
      data: {
        name: "Daily Market Research Digest with a Very Long Name",
        prompt: "Summarize the latest market trends for the team.",
        cronExpression: "0 9 * * *",
      },
    },
    {
      label: "task",
      listUrl: "/api/tasks",
      listKey: "tasks",
      createUrl: "/api/tasks",
      data: { title: "A very long task title that must truncate gracefully on small screens" },
    },
    {
      label: "infra machine",
      listUrl: "/api/infra/machines",
      listKey: "machines",
      createUrl: "/api/infra/machines",
      data: {
        name: "Production web server cluster with a very long hostname",
        host: "prod1.internal.example.com",
        port: 22,
        username: "deploy",
        authMethod: "key",
      },
    },
  ];

  for (const spec of seeds) {
    await ensureSeed(request, spec);
  }
}

interface SeedSpec {
  /** Used in log messages. */
  label: string;
  /** Endpoint listing existing records. */
  listUrl: string;
  /** Key of the array in the list response. */
  listKey: string;
  /** Endpoint creating the record. */
  createUrl: string;
  /** Payload for the create request; `name`/`title` doubles as the dedupe key. */
  data: Record<string, unknown>;
}

async function ensureSeed(request: APIRequestContext, spec: SeedSpec): Promise<void> {
  const existing = await request.get(spec.listUrl).catch((err) => {
    console.warn(`e2e seed: could not list ${spec.label}s`, err);
    return null;
  });
  if (!existing?.ok()) {
    console.warn(`e2e seed: listing ${spec.label}s failed (${existing?.status() ?? "error"})`);
    return;
  }

  const body = (await existing.json()) as Record<string, unknown>;
  const rows = body[spec.listKey];
  const key = (spec.data.name ?? spec.data.title) as string | undefined;
  const alreadySeeded =
    Array.isArray(rows) &&
    rows.some((row) => {
      const record = row as Record<string, unknown>;
      return record.name === key || record.title === key;
    });
  if (alreadySeeded) return;

  const created = await request.post(spec.createUrl, { data: spec.data }).catch((err) => {
    console.warn(`e2e seed: could not create ${spec.label}`, err);
    return null;
  });
  if (created && !created.ok()) {
    console.warn(`e2e seed: ${spec.label} not created (${created.status()})`);
  }
}

/**
 * Ensure the user has a local calendar account. The app creates it on demand;
 * the modal guardrails need it to reach calendar overlays.
 */
export async function ensureLocalCalendarAccount(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/calendar/ensure-local-account").catch((err) => {
    console.warn("e2e seed: local calendar account request failed", err);
    return null;
  });
  if (res && !res.ok()) console.warn(`e2e seed: local calendar account (${res.status()})`);
}

/**
 * Grant the shared e2e user the admin role.
 *
 * Only the first account in a database becomes admin (see the `user.create`
 * hook in `src/auth.ts`), and no API can promote the first admin  the better-auth
 * admin endpoints require an admin session. So the suite grants the role itself,
 * against the database the app under test reads.
 *
 * This exists because the admin routes were skipped on any database where a
 * human had signed up first: `/admin/models` shipped a crashing shell that no
 * test ever loaded.
 *
 * @throws when the database is unreachable or has no e2e user  pointing
 * `BASE_URL` at an app whose database this isn't means no admin coverage, which
 * must be a failure rather than a silent skip.
 */
export async function grantAdminRole(): Promise<void> {
  // Loaded lazily: this module is also imported by unit tests, which have no
  // business booting a database client.
  await import("dotenv/config");
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("e2e: DATABASE_URL is not set  the admin routes cannot be covered without it");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const updated = await prisma.user.updateMany({
      where: { email: E2E_EMAIL },
      data: { role: "admin" },
    });
    if (updated.count === 0) {
      throw new Error(
        `e2e: no ${E2E_EMAIL} row in ${connectionString}  is DATABASE_URL the database of the app under test?`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Let a freshly loaded route finish painting: the shell is on screen, the fonts
 * that decide text widths are in place, and two frames have gone by so layout
 * has settled.
 *
 * `quietNetwork` additionally waits for the fetches behind the first paint. It
 * is bounded on purpose: a page with a poll or an event stream never goes idle,
 * and `networkidle` alone used to cost a whole test timeout per page.
 */
export async function settle(page: Page, { quietNetwork = false } = {}): Promise<void> {
  // `load` lands after every chunk has run, which is where hydration happens: a
  // click before it does nothing and the test measures a page nobody wired up.
  await page.waitForLoadState("load").catch((err) => {
    console.warn(`e2e: the page never finished loading ${page.url()}`, err);
  });
  await page.locator(SHELL).first().waitFor({ state: "visible", timeout: 30_000 });
  if (quietNetwork) {
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

/**
 * Open a route and let lazy transitions settle. Returns the navigation response
 * for the suites that assert the route rendered at all.
 */
export async function gotoAndSettle(
  page: Page,
  path: string,
  options?: { quietNetwork?: boolean },
): Promise<Awaited<ReturnType<Page["goto"]>>> {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  await settle(page, options);
  return response;
}

/** A chat to open: the chat layout only renders with one. */
export async function createChatSession(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const response = await request.post("/api/chat/sessions", { data: { title } });
  if (!response.ok())
    throw new Error(`e2e: creating the chat "${title}" failed (${response.status()})`);
  const body = (await response.json()) as { session?: { id?: string } };
  if (!body.session?.id) throw new Error(`e2e: no session id for "${title}"`);
  return body.session.id;
}

/** Remove chats a test created. Failures are logged, never thrown. */
export async function discardChatSessions(
  request: APIRequestContext,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await request.delete(`/api/chat/sessions/${id}`).catch((err) => {
      console.error(`e2e: cleaning up chat ${id} failed`, err);
    });
  }
}
