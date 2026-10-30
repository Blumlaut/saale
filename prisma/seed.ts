#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Demo data for a checkout: a chat, a coder chat, and the git repo the coder
 * panel reads.
 *
 * It writes into the account named by `SEED_EMAIL` (`dev@saale.local` by
 * default, the one `scripts/dev.sh setup` makes) and only touches rows whose id
 * starts with `demo-`, so a second run replaces the demo and leaves every other
 * chat alone.
 */

import "dotenv/config";

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { coderBranchName, coderChatSlug } from "@/lib/coder/slug";
import { projectRepoPath, worktreePath } from "@/lib/coder/paths";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { hashPassword } from "better-auth/crypto";

const SEED_EMAIL = (process.env.SEED_EMAIL ?? "dev@saale.local").toLowerCase();
const SEED_USERNAME = (
  process.env.SEED_USERNAME ??
  SEED_EMAIL.split("@")[0] ??
  "dev"
).toLowerCase();
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "saale-dev-password";

/** The model the demo chats are set to, from Pi's catalog. */
const DEMO_MODEL = { provider: "openai", name: "gpt-5" } as const;

/** Every row this script owns, and the project the coder chat works in. */
const IDS = {
  chat: "demo-chat-launch-note",
  coderChat: "demo-chat-queue-drain",
  project: "demo-project-relay",
} as const;

const PROJECT_SLUG = "relay";
const PROJECT_NAME = "relay";

/** A tool call as the transcript renders one, minus the status the API adds. */
interface SeedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  /** Minutes before now, so the conversation reads as one from today. */
  minutesAgo: number;
  toolCalls?: SeedToolCall[];
}

const GENERAL_CHAT: SeedMessage[] = [
  {
    role: "user",
    minutesAgo: 46,
    content:
      "Draft a short launch note to the team about offline mode, and pick a send time that avoids our big meetings this week.",
  },
  {
    role: "assistant",
    minutesAgo: 45,
    content: `Here's the note:

## Offline mode is here

Saale keeps working with no connection at all. Drafts, chats and your files stay on device, and everything syncs the moment you are back.

- Works with no connection, not only a cached copy
- Changes merge cleanly when you reconnect

**Send time:** **Thursday 2:15pm**, just before the design review, while everyone is prepping anyway.

One thing first: QA says the app shell flickers once on a first launch with no network. Hold the send until that is patched, or ship it as it is?`,
    toolCalls: [
      {
        id: "demo-tool-calendar",
        name: "calendar_upcoming",
        args: { days: 7 },
        result: `3 events in the next 7 days.

Thursday 15:00  Design review    Work
Friday 13:00    Planning         Work
Saturday 16:00  Board readout    Work`,
      },
      {
        id: "demo-tool-mail",
        name: "mail_list",
        args: { folder: "INBOX", limit: 5 },
        result: `5 emails in INBOX.

Priya Raman   QA sign-off: offline shell flicker   unread
Build bot     nightly build passed
Marta Vogel   Q4 rollout numbers`,
      },
    ],
  },
  {
    role: "user",
    minutesAgo: 31,
    content:
      "Make it punchier and drop the second bullet. The flicker is fixed on main, so go ahead and send it to team@example.com.",
  },
  {
    role: "assistant",
    minutesAgo: 30,
    content: `Sent it to team@example.com, and put a follow-up in your calendar for Friday 9:30am so you can see how it landed after the design review.

The copy is three lines now and the merge bullet is gone. If the team asks for rollout numbers, say the word and I'll pull them.`,
    toolCalls: [
      {
        id: "demo-tool-mail-send",
        name: "mail_send",
        args: { to: ["team@example.com"], subject: "Offline mode is here" },
        result: "Sent to team@example.com.",
      },
      {
        id: "demo-tool-calendar-create",
        name: "calendar_create",
        args: { title: "Offline launch follow-up", start: "Friday 09:30" },
        result: "Created on Work.",
      },
    ],
  },
];

const CODER_CHAT: SeedMessage[] = [
  {
    role: "user",
    minutesAgo: 64,
    content:
      "The queue falls behind under load because the drain loop handles one job at a time. Batch the drain so it takes several jobs per pass, and make the batch size configurable.",
  },
  {
    role: "assistant",
    minutesAgo: 58,
    content: `Done. The drain loop now takes a batch of jobs per pass instead of one, so a busy queue stops starving under load.

- \`startDrain\` accepts a \`batchSize\` option (defaults to 1, so existing callers are unchanged).
- \`buildServer\` passes \`DRAIN_BATCH\` (default 16) from the environment.
- The suite passes.

That change is committed on the branch.`,
    toolCalls: [
      {
        id: "demo-tool-read-drain",
        name: "read",
        args: { filePath: "src/queue/handler.ts" },
        result: "Read 23 lines.",
      },
      {
        id: "demo-tool-edit-drain",
        name: "edit",
        args: { filePath: "src/queue/handler.ts" },
        result: "2 edits.",
      },
      {
        id: "demo-tool-bash-test",
        name: "bash",
        args: { command: "npm test" },
        result: "10 tests passed in 1.4s.",
      },
    ],
  },
  {
    role: "user",
    minutesAgo: 26,
    content:
      "Deliveries are flaky over the network. Add a retry to the job handler so a transient failure doesn't kill the job.",
  },
  {
    role: "assistant",
    minutesAgo: 21,
    content: `Added a two-attempt retry around delivery. A transient failure is retried once before the job is marked failed, and the store still records only the final outcome.

That one is uncommitted on the branch, next to the new \`src/metrics.ts\`, so you can review both together.`,
    toolCalls: [
      {
        id: "demo-tool-read-handler",
        name: "read",
        args: { filePath: "src/queue/handler.ts" },
        result: "Read 31 lines.",
      },
      {
        id: "demo-tool-edit-handler",
        name: "edit",
        args: { filePath: "src/queue/handler.ts" },
        result: "1 edit.",
      },
      {
        id: "demo-tool-write-metrics",
        name: "write",
        args: { filePath: "src/metrics.ts" },
        result: "Wrote 18 lines.",
      },
    ],
  },
];

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: PROJECT_SLUG,
    private: true,
    type: "module",
    scripts: {
      dev: "node --watch src/index.ts",
      start: "node src/index.ts",
      test: "node --test",
    },
  },
  null,
  2,
)}\n`;

const DELIVERY_TS = `export interface Delivery {
  id: string;
  destination: string;
  payload: unknown;
}

export async function deliver(job: Delivery): Promise<void> {
  const response = await fetch(job.destination, {
    method: "POST",
    body: JSON.stringify(job.payload),
  });
  if (!response.ok) throw new Error(\`delivery failed: \${response.status}\`);
}
`;

const STORE_TS = `import type { Delivery } from "../delivery.ts";

export interface Job extends Delivery {
  attempts: number;
}

export function createStore() {
  const jobs = new Map<string, Job>();
  return {
    add(job: Job) {
      jobs.set(job.id, job);
    },
    take(count: number): Job[] {
      return [...jobs.values()].slice(0, count);
    },
    remove(id: string) {
      jobs.delete(id);
    },
  };
}
`;

/** The drain as it is on main: one job per pass. */
const HANDLER_TS = `import { deliver } from "../delivery.ts";
import type { Job } from "./store.ts";

export async function startDrain(store: {
  take(count: number): Job[];
  remove(id: string): void;
}): Promise<void> {
  const [job] = store.take(1);
  if (!job) return;
  await deliver(job);
  store.remove(job.id);
}
`;

const INDEX_TS = `import { createStore } from "./queue/store.ts";
import { startDrain } from "./queue/handler.ts";

const store = createStore();

export function buildServer() {
  return { store, drain: () => startDrain(store) };
}
`;

/** The drain after the first message: batched, with the size from the environment. */
const BATCHED_HANDLER_TS = `import { deliver } from "../delivery.ts";
import type { Job } from "./store.ts";

/** How many jobs one pass takes off the queue when the caller has no opinion. */
const DEFAULT_BATCH = 1;

export async function startDrain(
  store: { take(count: number): Job[]; remove(id: string): void },
  options: { batchSize?: number } = {},
): Promise<number> {
  const batch = store.take(options.batchSize ?? DEFAULT_BATCH);
  for (const job of batch) {
    await deliver(job);
    store.remove(job.id);
  }
  return batch.length;
}
`;

const BATCHED_INDEX_TS = `import { createStore } from "./queue/store.ts";
import { startDrain } from "./queue/handler.ts";

const store = createStore();
const batch = Number(process.env.DRAIN_BATCH ?? 16);

export function buildServer() {
  return { store, drain: () => startDrain(store, { batchSize: batch }) };
}
`;

/** The uncommitted retry the second message left on the branch. */
const RETRY_HANDLER_TS = `import { deliver } from "../delivery.ts";
import { attemptCount } from "../metrics.ts";
import type { Job } from "./store.ts";

/** How many jobs one pass takes off the queue when the caller has no opinion. */
const DEFAULT_BATCH = 1;

/** Delivery is retried once before a job is given up on. */
const MAX_ATTEMPTS = 2;

export async function startDrain(
  store: { take(count: number): Job[]; remove(id: string): void },
  options: { batchSize?: number } = {},
): Promise<number> {
  const batch = store.take(options.batchSize ?? DEFAULT_BATCH);
  for (const job of batch) {
    await drainJob(store, job);
  }
  return batch.length;
}

async function drainJob(
  store: { remove(id: string): void },
  job: Job,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptCount(attempt);
    try {
      await deliver(job);
      store.remove(job.id);
      return;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) continue;
      console.error(\`delivery failed for \${job.id}:\`, err);
    }
  }
}
`;

const METRICS_TS = `/** Counters the drain loop keeps for the health endpoint. */
const counters = new Map<string, number>();

function bump(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function attemptCount(attempt: number): void {
  bump(attempt === 1 ? "delivery_attempt" : "delivery_retry");
}

export function drainRun(): void {
  bump("drain_run");
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
`;

/** Who git records as the author of the demo commits. */
const GIT_IDENTITY = ["-c", "user.name=dev", "-c", "user.email=dev@saale.local"];

/** A commit dated in the past, so the panel's "1h ago" is true. */
function commitEnv(minutesAgo: number): Record<string, string> {
  const date = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Write a file, creating its parents. */
async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writeAll(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await write(root, relative, content);
  }
}

/**
 * The repo the coder chat works in, and that chat's checkout of it.
 *
 * A bare `origin` under the workspace's scratch directory gives `main` an
 * upstream, so the panel can show the commit the branch is ahead by.
 */
async function seedRepo(
  userId: string,
  chatId: string,
): Promise<{ path: string; baseSha: string; branch: string }> {
  const workspace = userWorkspacePath(userId);
  const repoDir = path.join(workspace, projectRepoPath(PROJECT_SLUG));
  const checkout = worktreePath(PROJECT_SLUG, chatId);
  const checkoutDir = path.join(workspace, checkout);
  const originDir = path.join(workspace, ".tmp", "demo-origin", `${PROJECT_SLUG}.git`);

  await Promise.all([
    fs.rm(repoDir, { recursive: true, force: true }),
    fs.rm(checkoutDir, { recursive: true, force: true }),
    fs.rm(originDir, { recursive: true, force: true }),
  ]);
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(path.dirname(originDir), { recursive: true });

  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", originDir]);
  git(repoDir, ["init", "--quiet", "--initial-branch=main"]);
  git(repoDir, ["remote", "add", "origin", originDir]);

  await writeAll(repoDir, {
    "package.json": PACKAGE_JSON,
    "README.md": `# ${PROJECT_NAME}

A small job relay: it takes jobs off the queue and delivers them to their
destination.
`,
    "src/index.ts": INDEX_TS,
    "src/delivery.ts": DELIVERY_TS,
    "src/queue/handler.ts": HANDLER_TS,
    "src/queue/store.ts": STORE_TS,
  });
  git(repoDir, ["add", "--all"]);
  git(repoDir, ["commit", "--quiet", "-m", "scaffold relay service"], commitEnv(3 * 24 * 60));
  git(repoDir, ["push", "--quiet", "origin", "main"]);

  const baseSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
  const branch = coderBranchName(coderChatSlug(chatId));
  git(repoDir, ["worktree", "add", "--quiet", "-b", branch, checkoutDir, "main"]);
  git(checkoutDir, ["branch", "--set-upstream-to=origin/main"]);

  await writeAll(checkoutDir, {
    "src/index.ts": BATCHED_INDEX_TS,
    "src/queue/handler.ts": BATCHED_HANDLER_TS,
  });
  git(checkoutDir, ["add", "--all"]);
  git(checkoutDir, ["commit", "--quiet", "-m", "drain the queue in batches"], commitEnv(58));

  // The retry is staged, the store change is not, and metrics.ts is new.
  await write(checkoutDir, "src/queue/handler.ts", RETRY_HANDLER_TS);
  git(checkoutDir, ["add", "src/queue/handler.ts"]);
  await write(
    checkoutDir,
    "src/queue/store.ts",
    STORE_TS.replace(
      "    remove(id: string) {",
      "    size(): number {\n      return jobs.size;\n    },\n    remove(id: string) {",
    ),
  );
  await write(checkoutDir, "src/metrics.ts", METRICS_TS);

  return { path: checkout, baseSha, branch };
}

interface SeedSession {
  id: string;
  title: string;
  messages: SeedMessage[];
  projectId: string | null;
  worktree: { projectId: string; path: string; branch: string; baseSha: string } | null;
}

/** Replace the demo chats, leaving every other row in the account as it was. */
async function seedChats(userId: string, checkout: Awaited<ReturnType<typeof seedRepo>>) {
  await prisma.chatSession.deleteMany({ where: { userId, id: { startsWith: "demo-" } } });
  await prisma.coderProject.deleteMany({ where: { userId, id: IDS.project } });

  await prisma.coderProject.create({
    data: {
      id: IDS.project,
      userId,
      name: PROJECT_NAME,
      slug: PROJECT_SLUG,
      repoPath: projectRepoPath(PROJECT_SLUG),
      defaultBranch: "main",
      chatMode: "worktree",
      setupScript: "npm install",
    },
  });

  const sessions: SeedSession[] = [
    {
      id: IDS.chat,
      title: "Offline mode launch note",
      projectId: null,
      messages: GENERAL_CHAT,
      worktree: null,
    },
    {
      id: IDS.coderChat,
      title: "Batch the queue drain",
      projectId: IDS.project,
      messages: CODER_CHAT,
      worktree: {
        projectId: IDS.project,
        path: checkout.path,
        branch: checkout.branch,
        baseSha: checkout.baseSha,
      },
    },
  ];

  const now = Date.now();
  for (const session of sessions) {
    const first = session.messages[0]!;
    const last = session.messages[session.messages.length - 1]!;
    const lastActivityAt = new Date(now - last.minutesAgo * 60_000);

    await prisma.chatSession.create({
      data: {
        id: session.id,
        userId,
        title: session.title,
        titleSource: "user",
        messageCount: session.messages.length,
        thinkingLevel: "medium",
        modelProvider: DEMO_MODEL.provider,
        modelName: DEMO_MODEL.name,
        createdAt: new Date(now - (first.minutesAgo + 4) * 60_000),
        lastActivityAt,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        ...(session.worktree
          ? {
              coderWorktree: {
                create: { id: `${session.id}-worktree`, ...session.worktree, status: "active" },
              },
            }
          : {}),
        messages: {
          create: session.messages.map((message, index) => ({
            id: `${session.id}-message-${index + 1}`,
            role: message.role,
            content: message.content,
            createdAt: new Date(now - message.minutesAgo * 60_000),
            toolCalls: message.toolCalls
              ? JSON.stringify(message.toolCalls.map((call) => ({ ...call, isError: false })))
              : null,
          })),
        },
      },
    });
  }
}

/**
 * A placeholder key for the demo model.
 *
 * The picker lists a provider's models only once the account has a credential
 * for it, and the header would read "No Model" without one. Nothing calls the
 * provider with this key: the demo chats are already written.
 */
async function seedProvider(userId: string) {
  const existing = await prisma.providerApiKey.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (existing) return;

  await prisma.providerApiKey.create({
    data: {
      id: `demo-provider-${DEMO_MODEL.provider}`,
      userId,
      provider: DEMO_MODEL.provider,
      encryptedKey: encrypt("sk-demo-placeholder"),
    },
  });
}

/** The demo account, made the way `scripts/dev.sh setup` makes it. */
async function seedAccount(): Promise<string> {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: SEED_EMAIL }, { username: SEED_USERNAME }] },
    select: { id: true },
  });
  if (existing) return existing.id;

  const user = await prisma.user.create({
    data: {
      email: SEED_EMAIL,
      username: SEED_USERNAME,
      name: SEED_USERNAME,
      emailVerified: true,
      role: (await prisma.user.count()) === 0 ? "admin" : "user",
    },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await hashPassword(SEED_PASSWORD),
    },
  });

  return user.id;
}

async function main(): Promise<void> {
  const userId = await seedAccount();
  await seedProvider(userId);
  const checkout = await seedRepo(userId, IDS.coderChat);
  await seedChats(userId, checkout);

  console.log(
    `Seeded ${SEED_EMAIL} (${SEED_PASSWORD}): a launch-note chat and a coder chat ` +
      `on ${checkout.branch}.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("Seeding demo data failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
