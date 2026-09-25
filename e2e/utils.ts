import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

/**
 * Shared helpers for the layout guardrail suites (`mobile-overflow.spec.ts`,
 * `modal-overflow.spec.ts`).
 */

export const E2E_EMAIL = "e2e-mobile@saale.local";
export const E2E_PASSWORD = "TestPass123!";

/** Phone widths every guardrail runs at — see AGENTS.md "Mobile-First Layouts". */
export const VIEWPORTS = [
  { name: "375px", width: 375, height: 667 }, // iPhone SE
  { name: "320px", width: 320, height: 667 }, // smallest common phone
];

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Sign the shared e2e user up. An existing user is fine (any non-2xx is ignored). */
export async function ensureUser(request: APIRequestContext): Promise<void> {
  await request.post("/api/auth/sign-up/email", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD, name: "E2E Mobile" },
  });
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

/** Log the shared e2e user in and wait for the dashboard shell. */
export async function login(page: Page): Promise<void> {
  await page.goto("/auth/login");
  await page.fill('input[name="email"]', E2E_EMAIL);
  await page.fill('input[name="password"]', E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard/**", { timeout: 20_000 });
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

export interface E2ESession {
  storageState: StorageState;
  isAdmin: boolean;
}

/**
 * Create the e2e user (if needed), log in, seed stress data and capture the
 * session. Seeding runs through the logged-in context — API routes are
 * user-scoped and reject unauthenticated requests.
 */
export async function bootstrapSession(
  browser: Browser,
  request: APIRequestContext,
): Promise<E2ESession> {
  await ensureUser(request);

  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  await login(page);

  await seedStressData(page.request);
  await ensureLocalCalendarAccount(page.request);

  // Detect the admin role so admin-only tests can skip gracefully (existing
  // databases where a different user owns the admin role).
  const role = await page.evaluate(async () => {
    const res = await fetch("/api/auth/get-session");
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: { role?: string | null } } | null;
    return data?.user?.role ?? null;
  });

  const storageState = await ctx.storageState();
  await ctx.close();

  return { storageState, isAdmin: role === "admin" };
}

/** Open a route and let lazy transitions / polling settle. */
export async function gotoAndSettle(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}
