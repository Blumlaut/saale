import type { Page } from "@playwright/test";

import type {
  CouncilDetail,
  CouncilMessageView,
  CouncilRunView,
  CouncilSummary,
  CouncilTurnView,
} from "../src/types/council";

/**
 * Council fixtures shared by the specs that visit a council page.
 *
 * A room renders the values most likely to overflow a phone: a council name in
 * a toolbar, member posts carrying file paths and digests, a private turn trace
 * with tool arguments. The fixtures therefore carry hostile ones — a long name,
 * an unbreakable 64-character digest, a deep sandbox path — rather than
 * comfortable placeholders, because a fixture that cannot overflow tests
 * nothing.
 *
 * The API is mocked rather than seeded: a real council run costs several model
 * calls, and a spec that only measures layout has no business starting one.
 */

export const COUNCIL_E2E_ID = "e2e-council";
export const COUNCIL_MEMBER_ID = "e2e-member-alice";
export const COUNCIL_MEMBER_NAME = "alice";

/** A file name with no break opportunity, for the phone-width guardrails. */
export const FILES_LONG_NAME =
  "9f2c4a1e7b3d5086a4c1e9f2b7d3a5086c4e1a9f2b7d3c5086a4e1b9f2c7d3a5.json";
/** The file a modal scenario opens in the viewer. */
export const FILES_PREVIEW_NAME = "e2e-report.md";

const RUN_ID = "e2e-run-1";
const NOW = "2026-10-13T14:00:00.000Z";
const COUNCIL_NAME = "Launch review board with a very long name that must truncate";
const DIGEST = "9f2c4a1e7b3d5086a4c1e9f2b7d3a5086c4e1a9f2b7d3c5086a4e1b9f2c7d3a5";
const ARTIFACT = `/home/u3bd99582/artifacts/2026-10/launch-readiness/findings/${DIGEST}/report.md`;

export const COUNCIL_SUMMARY: CouncilSummary = {
  id: COUNCIL_E2E_ID,
  name: COUNCIL_NAME,
  brief: "Decide whether the launch is ready, name the risks, and stop when the council agrees.",
  orchestration: "parallel",
  stopVoteThreshold: "majority",
  toolConfig: { terminal: true },
  maxDurationSeconds: null,
  maxTokens: null,
  maxCostUsd: null,
  status: "running",
  sandboxReady: true,
  memberCount: 2,
  enabledMemberCount: 2,
  lastRunAt: NOW,
  createdAt: NOW,
};

const ACTIVE_RUN: CouncilRunView = {
  id: RUN_ID,
  status: "running",
  stopReason: null,
  turnCount: 3,
  inputTokens: 48210,
  outputTokens: 3120,
  cost: 0.4231,
  error: null,
  maxDurationSeconds: 1800,
  maxTokens: 200000,
  maxCostUsd: 5,
  startedAt: NOW,
  completedAt: null,
  createdAt: NOW,
};

export const COUNCIL_DETAIL: CouncilDetail = {
  ...COUNCIL_SUMMARY,
  members: [
    {
      id: COUNCIL_MEMBER_ID,
      name: COUNCIL_MEMBER_NAME,
      instructions: "Check the numbers and challenge the assumptions.",
      modelProvider: null,
      modelName: null,
      thinkingLevel: "default",
      toolConfig: null,
      enabled: true,
    },
    {
      id: "e2e-member-bob",
      name: "bob",
      instructions: "Own the launch checklist.",
      modelProvider: null,
      modelName: null,
      thinkingLevel: "default",
      toolConfig: null,
      enabled: true,
    },
  ],
  runs: [ACTIVE_RUN],
  lastSeq: 4,
  activeRun: ACTIVE_RUN,
};

export const COUNCIL_MESSAGES: CouncilMessageView[] = [
  {
    seq: 1,
    memberId: null,
    authorName: "you",
    authorKind: "user",
    content: `Kick off: is the launch ready? Answer under the digest ${DIGEST}.`,
    addressedNames: ["all"],
    runId: null,
    createdAt: NOW,
  },
  {
    seq: 2,
    memberId: null,
    authorName: "system",
    authorKind: "system",
    content: `bob could not start: provider request failed while reading ${ARTIFACT}`,
    addressedNames: [],
    runId: RUN_ID,
    createdAt: NOW,
  },
  {
    seq: 3,
    memberId: COUNCIL_MEMBER_ID,
    authorName: COUNCIL_MEMBER_NAME,
    authorKind: "member",
    content: `Audited ${ARTIFACT}: the index rebuild is the only risk I see. @bob take the checklist.`,
    addressedNames: ["bob"],
    runId: RUN_ID,
    createdAt: NOW,
  },
  {
    seq: 4,
    memberId: "e2e-member-bob",
    authorName: "bob",
    authorKind: "member",
    content: `Checklist is green apart from the rebuild window. @alice recheck the numbers.`,
    addressedNames: [COUNCIL_MEMBER_NAME],
    runId: RUN_ID,
    createdAt: NOW,
  },
];

export const COUNCIL_TURNS: CouncilTurnView[] = [
  {
    id: "e2e-turn-1",
    runId: RUN_ID,
    memberId: COUNCIL_MEMBER_ID,
    memberName: COUNCIL_MEMBER_NAME,
    status: "completed",
    thinking: `Weighing the rebuild window against the maintenance budget ${DIGEST}${DIGEST}`,
    toolCalls: [
      {
        id: "e2e-call-1",
        name: "read",
        args: { path: ARTIFACT, offset: 1, limit: 400 },
        result: "The index rebuild takes 40 minutes.",
        isError: false,
      },
      {
        id: "e2e-call-2",
        name: "bash",
        args: { command: `sha256sum ${ARTIFACT}` },
        result: `sha256sum: ${ARTIFACT}: No such file or directory`,
        isError: true,
      },
    ],
    finalText: `I posted the finding; the digest is ${DIGEST}. This closing text is private.`,
    postedSeqs: [3],
    triggeredBy: [1],
    seenThrough: 3,
    inputTokens: 12040,
    outputTokens: 880,
    cost: 0.121,
    error: null,
    startedAt: NOW,
    completedAt: NOW,
  },
];

/**
 * What the room's stream replays: one member thinking, so the live rail renders
 * the state that carries the longest unbreakable text.
 */
const COUNCIL_STREAM_BODY = [
  `event: ready\ndata: {}\n\n`,
  `event: turn_started\ndata: ${JSON.stringify({
    turnId: "e2e-turn-2",
    memberId: "e2e-member-bob",
    memberName: "bob",
    triggeredBy: [3],
    round: null,
  })}\n\n`,
  `event: thinking\ndata: ${JSON.stringify({
    memberId: "e2e-member-bob",
    memberName: "bob",
    thinking: `Checking the rebuild window against the runbook ${DIGEST}${DIGEST}`,
  })}\n\n`,
].join("");

/**
 * Answer the council API from the fixtures above.
 *
 * Non-GET requests fall through, so a spec that opens a dialog can still assert
 * on the dialog itself rather than on a mocked save. The stream is answered with
 * a replay and then closed, which is what keeps a page spec from starting a real
 * run (and a real model call) through its own EventSource.
 */
export async function mockCouncilRoom(page: Page): Promise<void> {
  await page.route(/\/api\/council\/[^/]+\/stream/, (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: COUNCIL_STREAM_BODY }),
  );

  await page.route(/\/api\/council\/[^/]+\/messages/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { messages: COUNCIL_MESSAGES, lastSeq: 4 } });
  });

  await page.route(/\/api\/council\/[^/]+\/turns/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { turns: COUNCIL_TURNS } });
  });

  await page.route(/\/api\/council(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { councils: [COUNCIL_SUMMARY] } });
  });

  // Last, so the paths above win: `[^/]+` cannot cross a slash, so this only
  // answers `/api/council/:id` itself.
  await page.route(/\/api\/council\/[^/]+(\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { council: COUNCIL_DETAIL } });
  });
}

/** The council routes the phone-width guardrails visit. */
export const COUNCIL_ROUTES = [
  "/dashboard/council",
  `/dashboard/council/${COUNCIL_E2E_ID}`,
  `/dashboard/council/${COUNCIL_E2E_ID}/member/${COUNCIL_MEMBER_ID}`,
  `/dashboard/council/${COUNCIL_E2E_ID}/files`,
];

/**
 * The workspace listing the file browser renders.
 *
 * Values are chosen to stress the row layout on a phone: an unbreakable 64-char
 * name, a folder, and a path deep enough to fill the breadcrumb.
 */
export const FILES_ROOT = `/home/${COUNCIL_E2E_ID}`;

export const FILES_LISTING = {
  target: {
    id: `council:${COUNCIL_E2E_ID}`,
    label: COUNCIL_NAME,
    root: FILES_ROOT,
    capabilities: { upload: true, createDirectory: true, rename: true, remove: true },
  },
  path: FILES_ROOT,
  truncated: false,
  entries: [
    {
      name: "artifacts",
      path: `${FILES_ROOT}/artifacts`,
      kind: "directory",
      size: 4096,
      modified: 1791904714445,
      writable: true,
    },
    {
      name: FILES_PREVIEW_NAME,
      path: `${FILES_ROOT}/${FILES_PREVIEW_NAME}`,
      kind: "file",
      size: 2048,
      modified: 1791904714445,
      writable: true,
    },
    {
      name: FILES_LONG_NAME,
      path: `${FILES_ROOT}/${FILES_LONG_NAME}`,
      kind: "file",
      size: 512,
      modified: 1791904714445,
      writable: true,
    },
  ],
};

/** Answer the file API from the fixtures above. */
export async function mockCouncilFiles(page: Page): Promise<void> {
  await page.route(/\/api\/files\/list/, (route) => route.fulfill({ json: FILES_LISTING }));

  // The viewer fetches text through the raw endpoint; anything else (a zip, a
  // download) is answered as bytes so a click never hangs the page.
  await page.route(/\/api\/files\/raw/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body:
        "# e2e report\n\nA very long line that would overflow a phone if the viewer let it: " +
        "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\n",
    }),
  );

  await page.route(/\/api\/files\/zip/, (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: "" }),
  );
}

/** Everything a council page needs, room and workspace alike. */
export async function mockCouncilWorkspace(page: Page): Promise<void> {
  await Promise.all([mockCouncilRoom(page), mockCouncilFiles(page)]);
}
