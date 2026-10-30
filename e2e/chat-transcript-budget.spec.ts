import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle, sessionContext } from "./utils";

/**
 * What a long transcript is allowed to cost.
 *
 * Chat memory had been growing with the shape of the turns, not with the
 * transcript: the render window held the last 20 turns whatever they contained,
 * and a coder turn runs hundreds of steps with a card each. Measured in a real
 * browser, because it is the mounted tree that costs, not the message list.
 *
 * Mocked messages: what is under test is how much of a transcript the app
 * mounts, not the model that produced it.
 */

const TURNS = 20;
const STEPS = 30;

interface Fixture {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
  attachments: undefined;
  toolCalls:
    | {
        id: string;
        name: string;
        args: Record<string, unknown>;
        status: "completed";
        result: string | undefined;
        error: string | undefined;
      }[]
    | undefined;
}

/** Conversation order is the server's `createdAt`, so a fixture must sort. */
function at(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
}

function userMessage(turn: number, index: number): Fixture {
  return {
    id: `u${turn}`,
    role: "user",
    content: `Question ${turn}`,
    thinking: undefined,
    parentMessageId: undefined,
    createdAt: at(index),
    attachments: undefined,
    toolCalls: undefined,
  };
}

function stepMessage(id: string, parentMessageId: string, step: number, index: number): Fixture {
  return {
    id,
    role: "assistant",
    content: "",
    thinking: undefined,
    parentMessageId,
    createdAt: at(index),
    attachments: undefined,
    toolCalls: [
      {
        id: `tc-${id}`,
        name: "bash",
        args: { command: `step ${step}` },
        status: "completed",
        result: "ok",
        error: undefined,
      },
    ],
  };
}

/** `turns` turns, each a run of `steps` steps that each ran one tool. */
function transcript(turns: number, steps: number): Fixture[] {
  const messages: Fixture[] = [];
  let index = 0;
  for (let turn = 0; turn < turns; turn++) {
    messages.push(userMessage(turn, index++));
    for (let i = 0; i < steps; i++)
      messages.push(stepMessage(`s${turn}-${i}`, `u${turn}`, i, index++));
    messages.push({
      ...stepMessage(`a${turn}`, `u${turn}`, steps, index++),
      content: `Answer ${turn}`,
    });
  }
  return messages;
}

let sessionId = "";

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  sessionId = await createChatSession(request, "transcript-budget");
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await discardChatSessions(request, [sessionId]);
});

async function openChat(
  browser: Browser,
  messages: Fixture[],
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await sessionContext(browser, { viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route(/\/api\/chat\/sessions\/[^/]+\/messages$/, (route) =>
    route.fulfill({
      json: { messages, queuedMessages: [], session: { title: "transcript-budget" } },
    }),
  );
  await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
  await page.locator("[data-transcript]").waitFor({ state: "visible", timeout: 20_000 });
  return { page, close: () => context.close() };
}

interface Cost {
  /** Assistant turns mounted in the transcript. */
  turns: number;
  elements: number;
  heapKb: number;
}

/** What the page is actually holding: mounted elements and used JS heap. */
async function costOf(page: Page): Promise<Cost> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("HeapProfiler.collectGarbage");
    const { usedSize } = (await client.send("Runtime.getHeapUsage")) as { usedSize: number };
    // The transcript only: the chat list beside it grows with the test database.
    const { turns, elements } = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>("[data-transcript]")
        ?.firstElementChild as HTMLElement | null;
      return {
        turns: content?.querySelectorAll("[data-transcript-column]").length ?? 0,
        elements: content?.getElementsByTagName("*").length ?? 0,
      };
    });
    return { turns, elements, heapKb: Math.round(usedSize / 1024) };
  } finally {
    await client.detach();
  }
}

test.describe("transcript budget", () => {
  test("mounts a bounded slice of a long, busy transcript", async ({ browser }) => {
    const { page, close } = await openChat(browser, transcript(TURNS, STEPS));
    try {
      await expect(page.getByText("Answer 19")).toBeVisible();

      // 620 messages, 600 of them step cards: the window stops at the row budget.
      await expect(page.getByText("Question 19")).toBeVisible();
      await expect(page.getByText("Question 0")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /earlier messages?$/ })).toBeVisible();

      const cost = await costOf(page);
      test.info().annotations.push({ type: "cost", description: JSON.stringify(cost) });

      // 20 turns of 30 steps: the window stops at the row budget, so four
      // turns are mounted. It used to be all 20, with a card or a summary row
      // for every step under them.
      expect(cost.turns).toBeLessThanOrEqual(6);
    } finally {
      await close();
    }
  });

  test("keeps one oversized turn bounded, with its detail one click away", async ({ browser }) => {
    const { page, close } = await openChat(browser, transcript(1, 200));
    try {
      await expect(page.getByText("Answer 0")).toBeVisible();

      // A 200-call run folds into a line: the cards are rendered when the row
      // is opened, not before. (The step-by-step transcript caps the same run
      // at its oldest step; see message-list-row-budget.test.tsx.)
      const cost = await costOf(page);
      test.info().annotations.push({ type: "cost", description: JSON.stringify(cost) });
      // Nothing of the run is mounted but its summary line.
      expect(cost.elements).toBeLessThan(600);

      await page
        .getByRole("button", { name: /used \d+ tools?/i })
        .first()
        .click();
      // The detail is deferred, not lost: opening the run renders its cards.
      await expect(page.getByText("step 199")).toBeVisible();
    } finally {
      await close();
    }
  });

  test("drops what was revealed once the reader is back on the tail", async ({ browser }) => {
    const { page, close } = await openChat(browser, transcript(30, 12));
    try {
      const scroller = page.locator("[data-transcript]");
      await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
      await expect(page.getByText("Question 0")).toHaveCount(0);

      // Reveal back to the first turn, a page at a time.
      const reveal = page.getByRole("button", { name: /earlier messages?$/ });
      for (let i = 0; i < 6 && (await reveal.isVisible().catch(() => false)); i++) {
        await reveal.click();
      }
      await expect(page.getByText("Question 0")).toHaveCount(1);

      // Back on the tail: the window is the tail again, so the turns revealed
      // above it are unmounted for the rest of the session.
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await expect(page.getByText("Question 0")).toHaveCount(0);
      await expect(page.getByText("Answer 29")).toBeVisible();
    } finally {
      await close();
    }
  });
});
