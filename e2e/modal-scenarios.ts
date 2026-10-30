import type { Page } from "@playwright/test";

import { gotoAndSettle } from "./utils";
import { settingsSection, type SettingsSectionId } from "@/lib/navigation/settings-nav";
import { FILES_PREVIEW_NAME, mockCouncilFiles, mockCouncilRoom } from "./council-mocks";

/**
 * Registry of every overlay instance the app renders.
 *
 * `modal-overflow.spec.ts` opens each scenario at phone widths and asserts the
 * overlay contract (see `overlay-layout.ts`); `__tests__/overlay-coverage.test.ts`
 * fails when a component renders an overlay that has no entry here, so a new
 * modal cannot ship without being checked (or explicitly skipped with a reason).
 */

export interface ModalScenario {
  /** Test title, e.g. `settings · add memory`. */
  name: string;
  /** Route the overlay is opened from. */
  path: string;
  /** Component file(s) rendering the overlay  verified by the coverage test. */
  sources: string[];
  /** Opens the overlay from a freshly loaded page. */
  open?: (page: Page) => Promise<void>;
  /** Stubs installed before navigation (fixtures the app can't create offline). */
  mock?: (page: Page) => Promise<void>;
  /** Documented reason this overlay can't be automated  the test is skipped. */
  skip?: string;
}

/**
 * Write a plugin's waiting dialog where `requestPluginUi` would.
 *
 * The chat polls `/api/plugin-ui/pending`, so the dialog shows up as it would
 * after a plugin called `ctx.ui.select`.
 */
async function seedPendingPluginDialog(page: Page): Promise<string> {
  await import("dotenv/config");
  const { Redis } = await import("ioredis");

  const me = (await (await page.request.get("/api/auth/get-session")).json()) as {
    user?: { id?: string };
  };
  const userId = me.user?.id;
  if (!userId) throw new Error("e2e: no signed-in user for the plugin dialog");

  const listed = (await (await page.request.get("/api/chat/sessions")).json()) as {
    sessions?: Array<{ id: string }>;
  };
  let sessionId = listed.sessions?.[0]?.id;
  if (!sessionId) {
    const created = await page.request.post("/api/chat/sessions", { data: {} });
    sessionId = ((await created.json()) as { session?: { id?: string } }).session?.id;
  }
  if (!sessionId) throw new Error("e2e: could not open a chat for the plugin dialog");

  const now = Date.now();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  try {
    await redis.setex(
      `saale:plugin-ui:${sessionId}:e2e-plugin-dialog-${now}`,
      120,
      JSON.stringify({
        id: `e2e-plugin-dialog-${now}`,
        sessionId,
        userId,
        kind: "select",
        title: "Deploy saale@2026.10.26 to production?",
        message: "The release script wants to roll the deployment to all three replicas.",
        options: ["Deploy now", "Deploy to staging first", "Skip this release"],
        createdAt: now,
        expiresAt: now + 120_000,
      }),
    );
  } finally {
    await redis.quit();
  }

  return sessionId;
}

const MACHINE_DIALOG = "src/components/infra/machine-dialog.tsx";
const NOTES_DIALOG = "src/components/infra/machine-notes-dialog.tsx";
const MEMORIES_TAB = "src/app/dashboard/settings/sections/memories-section.tsx";
const PROMPTS_TAB = "src/app/dashboard/settings/sections/prompts-section.tsx";
const MCP_TAB = "src/app/dashboard/settings/components/mcp-panel.tsx";
const MCP_SHEET = "src/app/dashboard/settings/components/mcp-server-sheet.tsx";
const PROVIDER_LOGIN_SHEET = "src/components/providers/provider-login-sheet.tsx";
const PROVIDER_ADD_SHEET = "src/components/providers/provider-add-sheet.tsx";
const MODEL_LIMITS_SHEET = "src/components/providers/model-limits-sheet.tsx";
const CODER_CREATE_DIALOG = "src/components/coder/project-create-dialog.tsx";
const FORCE_DELETE_DIALOG = "src/components/shared/force-delete-dialog.tsx";
const PROJECT_SETTINGS_SHEET = "src/components/coder/project-settings-sheet.tsx";
const CODER_LAYOUT = "src/app/dashboard/coder/layout.tsx";
const SETTINGS = settingsSection("profile").href;

/** Realistic ED25519 public key  the content that used to widen the dialog. */
const SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL9lKcBGX0hVdN8nWmP4pQZaT7Rcj2sBvUyE1k6tZxQo saale@machine";

const NOW = "2026-01-01T09:00:00.000Z";

/** A valid 1×1 PNG  just enough for the lightbox to have a real image to show. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const MEMORY_TITLE =
  "A very long memory title that must wrap instead of widening the dialog on small screens";
const MEMORY_CONTENT =
  "Long-form memory content used to exercise the memories dialogs at phone widths. ".repeat(6);
const PROMPT_CONTENT =
  "Review the staged changes. Focus on ${1:-correctness, security and error handling}.";
const NOTE_TITLE = "Deploy runbook with a very long descriptive title for the operator";
const NOTE_CONTENT =
  "1. Build the image\n2. Push to the registry\n3. Roll the deployment and watch the logs ".repeat(
    4,
  );

/** Locate the first *visible* match  the app renders a desktop and a mobile shell. */
function visible(page: Page, selector: string) {
  return page.locator(selector).filter({ visible: true }).first();
}

async function click(page: Page, selector: string) {
  const target = visible(page, selector);
  await target.waitFor({ state: "visible", timeout: 10_000 });
  await target.click();
}

/** Click the deepest visible element containing `text` (works for icon-only rows). */
async function clickText(page: Page, text: string) {
  const target = page.locator(`*:has-text(${JSON.stringify(text)}):visible`).last();
  await target.waitFor({ state: "visible", timeout: 10_000 });
  await target.click();
}

/** Settings sections are routes: open one directly, as a phone user would. */
async function openSettingsSection(page: Page, id: SettingsSectionId) {
  await gotoAndSettle(page, settingsSection(id).href);
}

/**
 * The e2e user has no endpoint of its own, and a per-model limit only exists
 * where Saale defines the models  so the list is stubbed with one.
 */
async function mockConfigurableModels(page: Page) {
  await mockProviderSignIn(page);
  await page.route(/\/api\/providers\/models(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "custom",
            name: "OpenAI-compatible",
            modelCount: 1,
            modelsConfigurable: true,
          },
        ],
        models: {
          custom: [
            {
              id: "qwen3.8-27b",
              name: "qwen3.8-27b",
              reasoning: true,
              vision: true,
              contextWindow: 131_072,
              maxOutputTokens: 8_192,
            },
          ],
        },
        totalModels: 1,
        disabledModels: [],
        endpointLimits: { custom: { contextWindow: null, maxOutputTokens: null } },
      },
    }),
  );
}

/**
 * Open the row action menu of a list card scoped by its text (the lists render
 * dropdown triggers per row, and the first one on the page belongs to another panel).
 */
async function openRowMenu(page: Page, rowText: string) {
  const row = page
    .locator("div.group")
    .filter({ has: page.locator('[data-slot="dropdown-menu-trigger"]') })
    .filter({ hasText: rowText })
    .filter({ visible: true })
    .last();
  await row.locator('[data-slot="dropdown-menu-trigger"]').click();
}

/** The seeded machine list always has at least one row to act on. */
async function openMachineDialog(page: Page, selector: string) {
  await click(page, selector);
}

async function mockMachineCreate(page: Page) {
  await page.route(/\/api\/infra\/machines$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 201,
      json: {
        machine: {
          id: "e2e-machine",
          name: "e2e-machine",
          host: "example.com",
          port: 22,
          username: "deploy",
          authMethod: "key",
          createdAt: NOW,
        },
        authorizedKeysEntry: SSH_PUBLIC_KEY,
      },
    });
  });
}

async function mockMachineNotes(page: Page) {
  await page.route(/\/api\/infra\/machines\/[^/]+\/notes(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        notes: [
          {
            id: "e2e-note",
            machineId: "e2e-machine",
            title: NOTE_TITLE,
            content: NOTE_CONTENT,
            category: "runbook",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    });
  });
}

/** One configured MCP server, with a URL and description long enough to matter on a phone. */
/**
 * A linked Telegram account and a fresh one-time code, so the link dialog can
 * be opened (and its unbreakable code rendered) without a live bot.
 */
async function mockTelegramLinked(page: Page) {
  await page.route(/\/api\/integrations\/telegram$/, async (route) => {
    const method = route.request().method();

    if (method === "GET") {
      return route.fulfill({
        json: {
          integration: {
            bot: { configured: true, enabled: true, username: "saale_bot" },
            link: {
              telegramUserId: "119075844",
              chatId: "119075844",
              displayName: "Test Operator",
              linkedAt: NOW,
            },
          },
        },
      });
    }

    if (method === "POST") {
      return route.fulfill({
        json: {
          code: "abcDEF123_-GHIJKL456_-mnopqr789_",
          deepLink: "https://t.me/saale_bot?start=abcDEF123_-GHIJKL456_-mnopqr789_",
          expiresAt: NOW,
          botUsername: "saale_bot",
        },
      });
    }

    return route.fallback();
  });
}

/**
 * A sign-in waiting on GitHub, so the dialog opens with a code that wraps the
 * box at a phone width and never needs a live device flow to render.
 */
async function mockGithubSignIn(page: Page) {
  const pending = {
    credential: null,
    pending: { code: "1B47-ABE8", url: "https://github.com/login/device" },
    error: null,
  };
  await page.route(/\/api\/integrations\/github$/, async (route) => {
    if (route.request().method() === "GET" || route.request().method() === "POST") {
      return route.fulfill({ json: pending });
    }
    return route.fulfill({ json: { credential: null, pending: null, error: null } });
  });
}

/**
 * The provider list and a sign-in in its most demanding state: a device code, an
 * authorization URL long enough to wrap, and a prompt waiting to be answered.
 */
async function mockProviderSignIn(page: Page) {
  await page.route(/\/api\/providers(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        providers: [],
        availableProviders: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            baseUrl: null,
            methods: [{ type: "oauth", label: "Sign in with OpenCode", subscription: true }],
            modelCount: 80,
            modelsConfigurable: false,
            custom: false,
            configured: false,
            source: null,
            isGlobal: false,
          },
        ],
      },
    });
  });
  await page.route(/\/api\/providers\/login(\?|$)/, async (route) => {
    if (route.request().method() === "DELETE") return route.fulfill({ json: { success: true } });
    if (route.request().method() === "POST") return route.fulfill({ json: { id: "e2e-login" } });
    return route.fulfill({
      json: {
        state: {
          id: "e2e-login",
          providerId: "opencode",
          authType: "oauth",
          status: "pending",
          events: [
            {
              kind: "device_code",
              userCode: "WDJB-MJHT",
              verificationUri: "https://opencode.ai/auth/device",
              expiresInSeconds: 900,
            },
            {
              kind: "auth_url",
              url: "https://opencode.ai/authorize?client_id=saale&response_type=code&redirect_uri=https%3A%2F%2Fopencode.ai%2Fcallback&code_challenge=averylongchallengevaluethatkeepsgoingandgoingandgoing&state=abcdefghijklmnopqrstuvwxyz0123456789",
              instructions: "Complete sign-in in your browser.",
            },
          ],
          prompt: {
            kind: "manual_code",
            seq: 1,
            message: "Complete login in your browser, or paste the final redirect URL here:",
            placeholder:
              "http://127.0.0.1:1455/auth/callback?code=very-long-code-value&state=abcdef",
          },
          error: null,
          updatedAt: NOW,
        },
      },
    });
  });
}

async function mockMcpServers(page: Page) {
  await page.route(/\/api\/mcp\/servers(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        servers: [
          {
            id: "e2e-mcp",
            name: "homeassistant",
            url: "https://homeassistant.local:8123/api/mcp",
            description: "Control the smart home",
            toolPolicy: "ask",
            enabled: true,
            hasToken: true,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    });
  });
}

async function mockMemories(page: Page) {
  await page.route(/\/api\/memories(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        memories: [
          {
            id: "e2e-memory",
            title: MEMORY_TITLE,
            content: MEMORY_CONTENT,
            collection: "facts",
            tags: ["e2e", "layout"],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        total: 1,
      },
    });
  });
  await page.route(/\/api\/memories\/collections(\?|$)/, (route) =>
    route.fulfill({
      json: {
        collections: [{ name: "facts", count: 1, topTags: ["e2e"] }],
        total: 1,
      },
    }),
  );
}

/** One prompt to edit and delete; its hint and description are the long parts. */
async function mockPrompts(page: Page) {
  await page.route(/\/api\/prompts(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        prompts: [
          {
            id: "e2e-prompt",
            name: "review",
            description:
              "Review the staged changes and name every behaviour the diff breaks before proposing a fix",
            argumentHint: "<path> [correctness, security and error handling]",
            scope: "coder",
            content: PROMPT_CONTENT,
            updatedAt: NOW,
          },
        ],
      },
    });
  });
}

async function mockContacts(page: Page) {
  await page.route(/\/api\/contacts(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        contacts: [
          {
            id: "e2e-contact",
            name: "An extremely long contact display name to exercise truncation",
            email: "averyveryverylonglocalpart@an-example-domain-that-keeps-going.co.uk",
            company: "Example Corp",
            notes: null,
            lastSentAt: NOW,
          },
        ],
      },
    });
  });
  await page.route(/\/api\/contacts\/recent(\?|$)/, (route) =>
    route.fulfill({ json: { recipients: [] } }),
  );
}

async function mockAgentRuns(page: Page) {
  await page.route(/\/api\/agent-jobs\/definitions\/[^/]+\/runs(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        runs: [
          {
            id: "e2e-run",
            status: "completed",
            prompt: "Summarize the latest market trends.",
            modelId: null,
            inputTokens: 1200,
            outputTokens: 340,
            cost: 0.0021,
            error: null,
            startedAt: NOW,
            completedAt: NOW,
            messageCount: 2,
            duration: 4200,
            createdAt: NOW,
          },
        ],
      },
    });
  });
  await page.route(/\/api\/agent-jobs\/runs\/[^/]+\/messages(\?|$)/, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "e2e-msg-1",
            role: "assistant",
            content: "Fetched the market digest and summarized it for the team.",
            thinking: "The tool returned a long, unbreakable payload.",
            toolCalls: [
              {
                id: "e2e-tool-1",
                name: "web_fetch",
                args: {
                  url: "https://example.com/a/very/long/unbreakable/path/that/keeps/going/and/going/forever",
                },
                result: JSON.stringify({
                  status: 200,
                  body: "x".repeat(240),
                }),
              },
            ],
            createdAt: NOW,
          },
        ],
      },
    }),
  );
}

async function mockWatchers(page: Page) {
  await page.route(/\/api\/watchers(\?|$)/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { watchers: [] } });
    }

    // A test run of the draft script: the long value is what used to widen the
    // overlay.
    return route.fulfill({
      json: {
        outcome: {
          status: "fired",
          value: {
            count: 3,
            subjects: [
              "Invoice 2026-0001 for the quarterly infrastructure renewal",
              "An unusually long subject line that must wrap rather than widen the dialog",
            ],
          },
          output: "checked 3 folders\nnone were empty",
          durationMs: 412,
          callCount: 2,
        },
      },
    });
  });
}

async function mockCalendarSubscriptions(page: Page) {
  await page.route(/\/api\/calendar\/subscriptions(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        subscriptions: [
          {
            id: "e2e-subscription",
            name: "Team holiday feed",
            url: "https://example.com/feeds/holidays.ics",
            calendarId: "e2e-calendar",
            calendarName: "Holidays",
            calendarColor: null,
            enabled: true,
            lastSyncedAt: NOW,
          },
        ],
      },
    });
  });
}

/** Chat fixtures are created through the real API; cached for the whole run. */
let chatSessionId: string | null = null;

async function ensureChatSession(page: Page): Promise<string> {
  if (chatSessionId) return chatSessionId;
  const res = await page.request.post("/api/chat/sessions", {
    data: { title: "Modal layout guardrail chat" },
  });
  const body = (await res.json()) as { session?: { id?: string } };
  if (!body.session?.id) throw new Error(`failed to create chat session: ${res.status()}`);
  chatSessionId = body.session.id;
  return chatSessionId;
}

async function gotoChatSession(page: Page, sessionId: string) {
  await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
}

/** A project list and one project's chats, so the coder overlays have rows. */
async function mockCoderProjects(page: Page) {
  await page.route(/\/api\/coder\/projects$/, (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: "e2e-project",
            name: "e2e-project-with-a-long-name",
            slug: "e2e-project-with-a-long-name",
            repoPath: "projects/e2e-project-with-a-long-name",
            defaultBranch: "main",
            worktreeCount: 1,
            chatCount: 1,
            lastActivityAt: NOW,
            // The landing page lists a project's latest chats under it.
            chats: [
              {
                id: "e2e-coder-chat",
                title: "A coder chat with a long title that has to wrap instead of widen",
                lastActivityAt: NOW,
                pinned: false,
                isGenerating: false,
                worktree: {
                  path: "worktrees/e2e/c-1a2b3c4d",
                  branch: "wt/c-1a2b3c4d",
                  status: "active",
                },
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/coder\/projects\/e2e-project$/, (route) =>
    route.fulfill({
      json: {
        project: {
          id: "e2e-project",
          name: "e2e-project-with-a-long-name",
          slug: "e2e-project-with-a-long-name",
          repoPath: "projects/e2e-project-with-a-long-name",
          defaultBranch: "main",
          originUrl: null,
          envFiles: [
            {
              path: "apps/a-very-long-app-directory-name-that-must-wrap/.env.local",
              content:
                "DATABASE_URL=postgresql://saale:a-very-long-password-that-has-to-wrap@localhost:5432/saale\n",
            },
          ],
          setupScript: "npm install && npm run db:generate -- --a-very-long-flag-that-has-to-wrap",
        },
        chats: [
          {
            id: "e2e-coder-chat",
            title: "A coder chat with a long title that has to wrap instead of widen",
            lastActivityAt: NOW,
            isGenerating: false,
            worktree: {
              path: "worktrees/e2e-project-with-a-long-name/c-1a2b3c4d",
              branch: "wt/c-1a2b3c4d-with-an-unusually-long-branch-name",
              status: "active",
            },
          },
        ],
      },
    }),
  );
}

/** A chat inside a project, so the coder chat header's sheets have somewhere to open from. */
async function mockCoderChat(page: Page) {
  await mockCoderProjects(page);
  await page.route(new RegExp(`/api/coder/sessions/[^/]+/status(\\?|$)`), (route) =>
    route.fulfill({
      json: {
        worktree: {
          path: "worktrees/e2e-project-with-a-long-name/c-1a2b3c4d",
          branch: "wt/c-1a2b3c4d",
          baseSha: "0".repeat(40),
          mode: "worktree",
        },
        project: {
          id: "e2e-project",
          name: "e2e-project-with-a-long-name",
          slug: "e2e-project-with-a-long-name",
        },
        branch: "wt/c-1a2b3c4d",
        head: "1".repeat(40),
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
        changes: [
          {
            path: "src/components/a-very-long-file-name-that-cannot-wrap-inside-a-narrow-panel.tsx",
            originalPath: null,
            added: 12,
            deleted: 3,
            staged: false,
            unstaged: true,
            untracked: false,
            conflicted: false,
          },
          {
            path: "src/lib/coder/git-actions-and-everything-the-panel-writes.ts",
            originalPath: null,
            added: 40,
            deleted: 2,
            staged: true,
            unstaged: false,
            untracked: false,
            conflicted: false,
          },
        ],
        commits: [
          {
            sha: "abcdef1234567890",
            shortSha: "abcdef1",
            subject: "add the git actions with a subject long enough to need two lines",
            date: new Date().toISOString(),
            author: "e2e",
            refs: [],
            pushed: false,
          },
        ],
        scripts: [],
        commitsTruncated: false,
        remotes: [],
        stashes: 0,
      },
    }),
  );
  await page.route(new RegExp(`/api/coder/sessions/[^/]+/branches$`), (route) =>
    route.fulfill({
      json: {
        branches: [
          { name: "wt/c-1a2b3c4d", upstream: "", current: true },
          { name: "main", upstream: "origin/main", current: false },
        ],
      },
    }),
  );
  await page.route(new RegExp(`/api/coder/sessions/[^/]+/pull-request$`), (route) =>
    route.fulfill({ json: { pullRequest: null } }),
  );
  await page.route(/\/api\/chat\/sessions\/[^/]+\/messages/, (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route(new RegExp(`/api/coder/sessions/[^/]+/ports$`), (route) =>
    route.fulfill({
      json: {
        enabled: true,
        domain: "preview.e2e.test",
        setup: null,
        ports: [
          {
            port: 5173,
            address: "0.0.0.0",
            loopback: false,
            pid: 120,
            command: "node /app/node_modules/.bin/vite --host 0.0.0.0",
            url: "https://user-e2e-5173-0123456789abcdef01234567.preview.e2e.test",
          },
        ],
      },
    }),
  );
  await page.route(/preview\.e2e\.test/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>preview</p>" }),
  );
}

export const MODAL_SCENARIOS: ModalScenario[] = [
  // ── Infrastructure ────────────────────────────────────────────────────────
  {
    name: "infra · add machine",
    path: "/dashboard/infra",
    sources: [MACHINE_DIALOG],
    open: (page) => openMachineDialog(page, 'button:has-text("Add Machine")'),
  },
  {
    name: "infra · setup ssh key",
    path: "/dashboard/infra",
    sources: [MACHINE_DIALOG],
    mock: mockMachineCreate,
    open: async (page) => {
      await openMachineDialog(page, 'button:has-text("Add Machine")');
      await visible(page, "#infra-name").fill("e2e-machine");
      await visible(page, "#infra-host").fill("example.com");
      await visible(page, "#infra-username").fill("deploy");
      await click(page, 'form button[type="submit"]');
      await page.locator(':text("Setup SSH Access"):visible').first().waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "infra · edit machine",
    path: "/dashboard/infra",
    sources: [MACHINE_DIALOG],
    open: (page) => openMachineDialog(page, 'button[title="Edit"]'),
  },
  {
    name: "infra · machine notes",
    path: "/dashboard/infra",
    sources: [NOTES_DIALOG],
    mock: mockMachineNotes,
    open: (page) => openMachineDialog(page, 'button[title="View notes"]'),
  },
  {
    name: "infra · delete note confirmation",
    path: "/dashboard/infra",
    sources: [NOTES_DIALOG],
    mock: mockMachineNotes,
    open: async (page) => {
      await openMachineDialog(page, 'button[title="View notes"]');
      await clickText(page, "Deploy runbook");
      await click(page, 'button:has-text("Delete")');
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    name: "tasks · new task",
    path: "/dashboard/tasks",
    sources: ["src/components/tasks/task-form.tsx"],
    open: (page) => click(page, 'button:has-text("New Task")'),
  },
  {
    name: "tasks · delete task confirmation",
    path: "/dashboard/tasks",
    sources: ["src/app/dashboard/tasks/page.tsx"],
    open: async (page) => {
      await click(page, '[data-slot="dropdown-menu-trigger"]');
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },
  {
    name: "tasks · chat from task",
    path: "/dashboard/tasks",
    sources: ["src/components/tasks/task-chat-dialog.tsx"],
    mock: async (page) => {
      await page.route(/\/api\/tasks(\?|$)/, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
          json: {
            tasks: [
              {
                id: "e2e-task",
                title:
                  "A very long task title that must wrap instead of widening the dialog on small screens",
                description:
                  "Long-form task description used to exercise the task chat dialog at phone widths.",
                status: "pending",
                priority: "high",
                dueDate: NOW,
                tags: ["e2e", "layout"],
                order: 0,
                source: "manual",
                sourceEmailId: null,
                completedAt: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        });
      });
    },
    open: async (page) => {
      await click(page, '[data-slot="dropdown-menu-trigger"]');
      await click(page, '[role="menuitem"]:has-text("Chat")');
    },
  },

  // ── Jobs ──────────────────────────────────────────────────────────────────
  {
    name: "jobs · new agent job",
    path: "/dashboard/jobs/agents",
    sources: ["src/components/jobs/agent-job-dialog.tsx"],
    open: (page) => click(page, 'button:has-text("New agent")'),
  },
  {
    name: "jobs · new scheduled job",
    path: "/dashboard/jobs/scheduled",
    sources: ["src/components/jobs/job-dialog.tsx"],
    open: (page) => click(page, 'button:has-text("New job")'),
  },
  {
    name: "jobs · agent run messages",
    path: "/dashboard/jobs/agents",
    sources: ["src/components/jobs/agent-job-list.tsx"],
    mock: mockAgentRuns,
    open: async (page) => {
      await clickText(page, "Daily Market Research Digest");
      await clickText(page, "Completed");
    },
  },
  {
    name: "jobs · new watcher",
    path: "/dashboard/jobs/watchers",
    // The watcher dialog carries the longest content in the app: a script and a
    // script's returned value, both of which used to widen auto-sized overlay
    // tracks.
    sources: ["src/components/jobs/watcher-dialog.tsx"],
    mock: mockWatchers,
    open: (page) => click(page, 'button:has-text("New watcher")'),
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    name: "chat · session list sheet",
    path: "/dashboard/chat",
    sources: ["src/components/chat/mobile-session-sheet.tsx"],
    open: (page) => click(page, '[data-slot="sheet-trigger"]'),
  },
  {
    name: "chat · delete selected chats",
    path: "/dashboard/chat",
    sources: [FORCE_DELETE_DIALOG],
    open: async (page) => {
      // At phone widths the session list only exists inside the sheet, so the
      // selection has to be started from there.
      await gotoChatSession(page, await ensureChatSession(page));
      await click(page, '[data-slot="sheet-trigger"]');
      const sheet = page.locator('[data-slot="sheet-content"]:visible').last();
      await sheet.locator('[data-slot="dropdown-menu-trigger"]').first().click();
      await click(page, '[role="menuitem"]:has-text("Select chat")');
      await click(page, 'button[aria-label="Delete 1 selected chat"]');
    },
  },
  {
    name: "chat · share dialog",
    path: "/dashboard/chat",
    sources: ["src/components/chat/share-button.tsx"],
    open: async (page) => {
      await gotoChatSession(page, await ensureChatSession(page));
      await click(page, '[data-slot="dialog-trigger"]');
    },
  },
  {
    name: "chat · image lightbox",
    path: "/dashboard/chat",
    sources: ["src/components/chat/image-lightbox.tsx"],
    open: async (page) => {
      // Dedicated session: the shared one may be busy while other scenarios
      // post into it, and a busy session queues the message out of the list.
      const res = await page.request.post("/api/chat/sessions", {
        data: { title: "Modal layout guardrail chat lightbox" },
      });
      const body = (await res.json()) as { session?: { id?: string } };
      if (!body.session?.id)
        throw new Error(`failed to create lightbox chat session: ${res.status()}`);
      const sessionId = body.session.id;

      // Block the SSE stream in the browser: the seeded message sets a pending
      // prompt, and a real stream connection would claim it and start an agent
      // run the guardrail doesn't need.
      await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) =>
        route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
      );

      // Stage the image the way the composer does, then send its id.
      const fixture = Buffer.from(PNG_1X1, "base64");
      const init = await page.request.post("/api/files/upload/init", {
        data: { path: "", name: "e2e-lightbox.png", size: fixture.length, inbox: true },
      });
      const { uploadId } = (await init.json()) as { uploadId: string };
      await page.request.put(`/api/files/upload/chunk?index=0&id=${uploadId}`, {
        data: fixture,
        headers: { "Content-Type": "application/octet-stream" },
      });
      const sent = await page.request.post(`/api/chat/sessions/${sessionId}/messages`, {
        data: {
          content: "e2e lightbox fixture",
          attachments: [
            {
              uploadId,
              fileName: "e2e-lightbox.png",
              mimeType: "image/png",
              size: fixture.length,
            },
          ],
        },
      });
      if (!sent.ok())
        throw new Error(`failed to seed lightbox message: ${sent.status()} ${await sent.text()}`);

      await gotoChatSession(page, sessionId);
      await click(page, 'button[aria-label="View e2e-lightbox.png"]');
    },
  },
  {
    name: "chat · compaction confirmation",
    path: "/dashboard/chat",
    sources: ["src/components/chat/token-usage-display.tsx"],
    open: async (page) => {
      await gotoChatSession(page, await ensureChatSession(page));
      await click(page, 'button[aria-label*="compact" i]');
    },
  },
  {
    name: "chat · slash command picker",
    path: "/dashboard/chat",
    sources: ["src/components/chat/command-sheet.tsx"],
    open: async (page) => {
      await gotoChatSession(page, await ensureChatSession(page));
      const composer = visible(page, 'textarea[placeholder="Message Saale..."]');
      await composer.fill("/model");
      await composer.press("Enter");
      await page.locator('[data-slot="sheet-content"]').waitFor({ state: "visible" });
    },
  },
  {
    name: "chat · linked watchers",
    path: "/dashboard/chat",
    sources: ["src/components/chat/session-links-panel.tsx"],
    mock: async (page) => {
      // The header button only appears when the session has linked watchers,
      // so the listing is stubbed  the guardrail is the panel's layout, not
      // the watcher data.
      await page.route(/\/api\/chat\/sessions\/[^/]+\/watchers/, (route) =>
        route.fulfill({
          json: {
            watchers: [
              {
                id: "e2e-watch-1",
                name: "deploy-watch",
                enabled: true,
                cronExpression: "*/5 * * * *",
                lastTickAt: NOW,
                lastFiredAt: NOW,
                lastError: "fetch failed: ECONNRESET",
                fireCount: 3,
              },
              {
                id: "e2e-watch-2",
                name: "inbox-digest",
                enabled: false,
                cronExpression: "0 * * * *",
                lastTickAt: null,
                lastFiredAt: null,
                lastError: null,
                fireCount: 0,
              },
            ],
          },
        }),
      );
    },
    open: async (page) => {
      await gotoChatSession(page, await ensureChatSession(page));
      await click(page, 'button[title="Linked watchers"]');
    },
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  {
    name: "settings · section picker",
    path: settingsSection("models").href,
    sources: ["src/components/layout/section-picker.tsx"],
    open: (page) => click(page, '[aria-label^="Settings section:"]'),
  },
  {
    name: "settings · add memory",
    path: SETTINGS,
    sources: [MEMORIES_TAB],
    open: async (page) => {
      await openSettingsSection(page, "memories");
      await click(page, 'button:has-text("Add Memory")');
    },
  },
  {
    name: "settings · edit memory",
    path: SETTINGS,
    sources: [MEMORIES_TAB],
    mock: mockMemories,
    open: async (page) => {
      await openSettingsSection(page, "memories");
      await openRowMenu(page, "very long memory title");
      await click(page, '[role="menuitem"]:has-text("Edit")');
    },
  },
  {
    name: "settings · delete memory confirmation",
    path: SETTINGS,
    sources: [MEMORIES_TAB],
    mock: mockMemories,
    open: async (page) => {
      await openSettingsSection(page, "memories");
      await openRowMenu(page, "very long memory title");
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },
  {
    name: "settings · new prompt",
    path: SETTINGS,
    sources: [PROMPTS_TAB],
    open: async (page) => {
      await openSettingsSection(page, "prompts");
      await click(page, 'button:has-text("New prompt")');
    },
  },
  {
    name: "settings · edit prompt",
    path: SETTINGS,
    sources: [PROMPTS_TAB],
    mock: mockPrompts,
    open: async (page) => {
      await openSettingsSection(page, "prompts");
      await openRowMenu(page, "/review");
      await click(page, '[role="menuitem"]:has-text("Edit")');
    },
  },
  {
    name: "settings · delete prompt confirmation",
    path: SETTINGS,
    sources: [PROMPTS_TAB],
    mock: mockPrompts,
    open: async (page) => {
      await openSettingsSection(page, "prompts");
      await openRowMenu(page, "/review");
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },
  {
    name: "settings · link telegram",
    path: SETTINGS,
    sources: ["src/components/integrations/telegram-card.tsx"],
    open: async (page) => {
      await openSettingsSection(page, "integrations");
      await click(page, 'button:has-text("Link Telegram")');
    },
  },
  {
    name: "settings · connect github",
    path: SETTINGS,
    sources: ["src/components/integrations/github-card.tsx"],
    mock: mockGithubSignIn,
    open: async (page) => {
      await openSettingsSection(page, "integrations");
      await click(page, 'button:has-text("Connect GitHub")');
    },
  },
  {
    name: "settings · unlink telegram confirmation",
    path: SETTINGS,
    sources: ["src/app/dashboard/settings/sections/integrations-section.tsx"],
    mock: mockTelegramLinked,
    open: async (page) => {
      await openSettingsSection(page, "integrations");

      // Anchor on the mocked display name: it only exists inside the Telegram
      // box, so the row menu is unambiguous even though the shell has its own.
      const box = page
        .locator("div")
        .filter({ hasText: "Test Operator" })
        .filter({ has: page.locator('[data-slot="dropdown-menu-trigger"]') })
        .last();
      await box.locator('[data-slot="dropdown-menu-trigger"]').click();
      await click(page, '[role="menuitem"]:has-text("Unlink")');
    },
  },
  {
    name: "settings · connect provider",
    path: SETTINGS,
    sources: [PROVIDER_LOGIN_SHEET],
    mock: mockProviderSignIn,
    open: async (page) => {
      await openSettingsSection(page, "models");
      await click(page, 'button:has-text("Manage providers")');
      await click(page, 'button:has-text("Sign in")');
      await page.locator(':text("Connect OpenCode Zen"):visible').first().waitFor({
        timeout: 10_000,
      });
    },
  },
  {
    name: "settings · add provider",
    path: SETTINGS,
    sources: [PROVIDER_ADD_SHEET],
    mock: mockProviderSignIn,
    open: async (page) => {
      await openSettingsSection(page, "models");
      await click(page, 'button:has-text("Manage providers")');
      await page
        .locator('input[aria-label="Search providers"]:visible')
        .first()
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "settings · model limits",
    path: SETTINGS,
    sources: [MODEL_LIMITS_SHEET],
    mock: mockConfigurableModels,
    open: async (page) => {
      await openSettingsSection(page, "models");
      // The inventory lives under a fold, and only the fold's title names it.
      await click(page, 'button:has-text("Hide the models you never pick.")');
      await click(page, '[title="Set this model\'s context window and output cap"]');
    },
  },
  {
    name: "settings · add mcp server",
    path: SETTINGS,
    sources: [MCP_SHEET],
    mock: mockMcpServers,
    open: async (page) => {
      await openSettingsSection(page, "integrations");
      await click(page, '[aria-label="Add server"]');
    },
  },
  {
    name: "settings · remove mcp server confirmation",
    path: SETTINGS,
    sources: [MCP_TAB],
    mock: mockMcpServers,
    open: async (page) => {
      await openSettingsSection(page, "integrations");
      await click(page, '[aria-label="Remove homeassistant"]');
    },
  },
  {
    name: "settings · add email account",
    path: SETTINGS,
    sources: ["src/components/mail/account-sheet.tsx"],
    open: async (page) => {
      await openSettingsSection(page, "email");
      await click(page, 'button:has-text("Add Account")');
    },
  },
  {
    name: "settings · add caldav account",
    path: SETTINGS,
    sources: ["src/components/calendar/calendar-account-dialog.tsx"],
    open: async (page) => {
      await openSettingsSection(page, "calendar");
      await click(page, 'button:has-text("Add CalDAV")');
    },
  },
  {
    name: "settings · add calendar subscription",
    path: SETTINGS,
    sources: ["src/components/calendar/subscription-dialog.tsx"],
    open: async (page) => {
      await openSettingsSection(page, "calendar");
      await click(page, 'button:has-text("Add Subscription")');
    },
  },
  {
    name: "settings · remove calendar subscription confirmation",
    path: SETTINGS,
    sources: ["src/app/dashboard/settings/sections/calendar-section.tsx"],
    mock: mockCalendarSubscriptions,
    open: async (page) => {
      await openSettingsSection(page, "calendar");
      await click(page, '[data-slot="dropdown-menu-trigger"]');
      await click(page, '[role="menuitem"]:has-text("Remove")');
    },
  },
  {
    name: "settings · telegram link",
    path: SETTINGS,
    sources: ["src/components/integrations/telegram-card.tsx"],
    mock: mockTelegramLinked,
    open: async (page) => {
      await openSettingsSection(page, "integrations");

      // Anchor on the mocked link's name  it only exists inside this card, so
      // the row menu is unambiguous even though the shell has its own menus.
      // Filtering by the trigger too picks the card itself, not the inner div
      // that happens to hold the text.
      const card = page
        .locator("div")
        .filter({ hasText: "Test Operator" })
        .filter({ has: page.locator('[data-slot="dropdown-menu-trigger"]') })
        .last();
      await card.locator('[data-slot="dropdown-menu-trigger"]').click();
      await click(page, '[role="menuitem"]:has-text("Link a different account")');
      await click(page, 'button:has-text("Get link code")');
    },
  },

  // ── Calendar ──────────────────────────────────────────────────────────────
  {
    name: "calendar · new event",
    path: "/dashboard/calendar",
    sources: ["src/components/calendar/event-dialog.tsx"],
    open: (page) => click(page, 'button:has-text("New Event")'),
  },
  {
    name: "calendar · add calendar sheet",
    path: "/dashboard/calendar",
    sources: ["src/components/calendar/calendar-sidebar.tsx"],
    open: (page) => click(page, 'button[aria-label="Add calendar"]'),
  },
  {
    name: "calendar · event details",
    path: "/dashboard/calendar",
    sources: ["src/components/calendar/event-view-sheet.tsx"],
    skip: "requires an event on the grid  the e2e user has a local calendar but no seeded event",
  },

  // ── Mail ──────────────────────────────────────────────────────────────────
  {
    name: "mail · compose",
    path: "/dashboard/mail",
    sources: ["src/components/mail/compose-sheet.tsx"],
    skip: "requires a connected IMAP/SMTP account",
  },
  {
    name: "mail · email detail",
    path: "/dashboard/mail",
    sources: ["src/components/mail/email-detail-sheet.tsx"],
    skip: "requires a connected IMAP/SMTP account",
  },
  {
    name: "mail · reply / forward",
    path: "/dashboard/mail",
    sources: ["src/components/mail/reply-forward-sheet.tsx"],
    skip: "requires a connected IMAP/SMTP account",
  },

  // ── Contacts ────────────────────────────────────────────────────────────
  {
    name: "contacts · new contact",
    path: "/dashboard/contacts",
    sources: ["src/components/contacts/contact-sheet.tsx"],
    open: async (page) => {
      await click(page, 'button:has-text("New Contact")');
    },
  },
  {
    name: "contacts · edit contact",
    path: "/dashboard/contacts",
    sources: ["src/components/contacts/contact-sheet.tsx"],
    mock: mockContacts,
    open: async (page) => {
      await visible(page, 'div.group:has-text("extremely long contact display name")')
        .first()
        .click();
    },
  },
  {
    name: "contacts · delete contact confirmation",
    path: "/dashboard/contacts",
    sources: ["src/components/contacts/contacts-panel.tsx"],
    mock: mockContacts,
    open: async (page) => {
      await openRowMenu(page, "extremely long contact display name");
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },
  {
    name: "settings · remove email account confirmation",
    path: SETTINGS,
    sources: ["src/app/dashboard/settings/sections/email-section.tsx"],
    skip: "requires a connected IMAP/SMTP account",
  },

  {
    name: "settings · two-factor setup",
    path: SETTINGS,
    sources: ["src/components/auth/two-factor-dialog.tsx"],
    open: async (page) => {
      await openSettingsSection(page, "security");
      await click(page, 'button:has-text("Set up two-factor")');
    },
  },
  {
    name: "settings · two-factor disable / backup codes",
    path: SETTINGS,
    sources: ["src/components/auth/two-factor-dialog.tsx"],
    skip: "only reachable once a user has enabled 2FA, which the shared e2e account never does",
  },

  // ── Council ───────────────────────────────────────────────────────────────
  {
    name: "council · new council",
    path: "/dashboard/council",
    sources: ["src/components/council/council-dialog.tsx"],
    open: (page) => click(page, 'button[aria-label="New council"]'),
  },
  {
    name: "council · edit council",
    path: "/dashboard/council",
    sources: ["src/components/council/council-dialog.tsx"],
    mock: mockCouncilRoom,
    open: async (page) => {
      await click(page, 'button[aria-label^="Actions for"]');
      await click(page, '[role="menuitem"]:has-text("Edit")');
    },
  },
  {
    name: "council · delete council confirmation",
    path: "/dashboard/council",
    sources: ["src/app/dashboard/council/page.tsx"],
    mock: mockCouncilRoom,
    open: async (page) => {
      await click(page, 'button[aria-label^="Actions for"]');
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },

  // ── Coder ─────────────────────────────────────────────────────────────────
  {
    name: "coder · new project",
    path: "/dashboard/coder",
    sources: [CODER_CREATE_DIALOG],
    mock: mockCoderProjects,
    open: async (page) => {
      await click(page, 'button:has-text("New project")');
      await click(page, 'button:has-text("Next")');
    },
  },
  {
    name: "coder · project settings",
    path: "/dashboard/coder",
    sources: [PROJECT_SETTINGS_SHEET],
    mock: mockCoderProjects,
    open: async (page) => {
      await openRowMenu(page, "e2e-project-with-a-long-name");
      await click(page, '[role="menuitem"]:has-text("Project settings")');
    },
  },
  {
    name: "coder · delete project confirmation",
    path: "/dashboard/coder",
    sources: [FORCE_DELETE_DIALOG],
    mock: mockCoderProjects,
    open: async (page) => {
      await openRowMenu(page, "e2e-project-with-a-long-name");
      await click(page, '[role="menuitem"]:has-text("Delete project")');
    },
  },
  {
    name: "coder · delete chat confirmation",
    path: "/dashboard/coder/e2e-project",
    sources: [FORCE_DELETE_DIALOG],
    mock: mockCoderProjects,
    open: async (page) => {
      await click(page, '[aria-label^="Actions for A coder chat with a long title"]');
      await click(page, '[role="menuitem"]:has-text("Delete chat")');
    },
  },
  {
    name: "coder · chat list sheet",
    path: "/dashboard/coder/e2e-project/e2e-coder-chat",
    sources: [CODER_LAYOUT],
    mock: mockCoderChat,
    open: (page) => click(page, '[aria-label="Open chat list"]'),
  },
  {
    name: "coder · commit dialog",
    path: "/dashboard/coder/e2e-project/e2e-coder-chat",
    sources: ["src/components/coder/commit-dialog.tsx"],
    mock: mockCoderChat,
    open: async (page) => {
      await click(page, '[aria-label="Open worktree panel"]');
      await click(page, 'button:has-text("Commit…")');
    },
  },
  {
    name: "coder · discard changes confirmation",
    path: "/dashboard/coder/e2e-project/e2e-coder-chat",
    sources: ["src/components/coder/discard-dialog.tsx"],
    mock: mockCoderChat,
    open: async (page) => {
      await click(page, '[aria-label="Open worktree panel"]');
      await click(page, '[aria-label^="Actions for a-very-long-file-name"]');
      await click(page, '[role="menuitem"]:has-text("Discard changes")');
    },
  },
  {
    name: "coder · new branch dialog",
    path: "/dashboard/coder/e2e-project/e2e-coder-chat",
    sources: ["src/components/coder/branch-dialog.tsx"],
    mock: mockCoderChat,
    open: async (page) => {
      await click(page, '[aria-label="Open worktree panel"]');
      await click(page, '[aria-label="Branches"]');
      await click(page, '[role="menuitem"]:has-text("New branch")');
    },
  },
  {
    name: "coder · worktree sheet",
    path: "/dashboard/coder/e2e-project/e2e-coder-chat",
    sources: [CODER_LAYOUT],
    mock: mockCoderChat,
    open: async (page) => {
      await click(page, '[aria-label="Open worktree panel"]');
      await click(page, '[role="tab"]:has-text("Terminal")');
    },
  },

  // ── Council workspace files ───────────────────────────────────────────────
  {
    name: "council · file preview",
    path: `/dashboard/council/e2e-council/files`,
    sources: ["src/components/files/file-viewer.tsx"],
    mock: mockCouncilFiles,
    open: (page) => click(page, `button:has-text("${FILES_PREVIEW_NAME}")`),
  },
  {
    name: "council · new folder",
    path: `/dashboard/council/e2e-council/files`,
    sources: ["src/components/files/file-prompt-sheet.tsx"],
    mock: mockCouncilFiles,
    open: async (page) => {
      await click(page, 'button[aria-label="More actions"]');
      await click(page, '[role="menuitem"]:has-text("New folder")');
    },
  },
  {
    name: "council · file delete confirmation",
    path: `/dashboard/council/e2e-council/files`,
    sources: ["src/components/files/file-delete-dialog.tsx"],
    mock: mockCouncilFiles,
    open: async (page) => {
      await click(page, `button[aria-label="Actions for ${FILES_PREVIEW_NAME}"]`);
      await click(page, '[role="menuitem"]:has-text("Delete")');
    },
  },

  // ── Admin ─────────────────────────────────────────────────────────────────
  {
    name: "admin · telegram bot",
    path: "/admin/settings",
    sources: ["src/components/admin/telegram-bot-panel.tsx"],
    skip: "admin-only surface  the overlay needs a configured bot to render its trigger",
  },
  {
    name: "admin · user dialogs",
    path: "/admin/users",
    sources: ["src/app/admin/users/page.tsx"],
    skip: "not automated yet  the admin overlays need their own `open` steps",
  },
  {
    name: "admin · install plugin",
    path: "/admin/plugins/installed",
    sources: ["src/components/admin/plugin-dialogs.tsx"],
    open: async (page) => {
      await click(page, 'button[aria-label="Install"]');
      await visible(page, "#plugin-spec").waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    name: "chat · plugin dialog",
    path: "/dashboard/chat",
    sources: ["src/components/chat/plugin-dialog.tsx"],
    // A live plugin opens this one mid-run; seeding the request it would write
    // gives the same dialog without spending a model call.
    open: async (page) => {
      const sessionId = await seedPendingPluginDialog(page);
      await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
      const dialog = visible(page, "text=Deploy saale@2026.10.26 to production?");
      // The chat polls for pending dialogs every few seconds; a seed the server
      // read before it was written is worth another seed, not a failed run.
      await dialog.waitFor({ state: "visible", timeout: 15_000 }).catch(async (err) => {
        console.warn("e2e: the plugin dialog never showed, seeding it again", err);
        await seedPendingPluginDialog(page);
        await dialog.waitFor({ state: "visible", timeout: 15_000 });
      });
    },
  },
  {
    name: "admin · add role",
    path: "/admin/roles",
    sources: ["src/app/admin/roles/page.tsx"],
    open: async (page) => {
      await click(page, 'button[title="Create a role"]');
      await visible(page, "#role-name").waitFor({ state: "visible", timeout: 10_000 });
    },
  },
];
