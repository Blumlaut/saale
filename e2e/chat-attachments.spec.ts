import { test, expect } from "@playwright/test";

import { clearTranscript, seedAttachmentMessage } from "./fixtures";
import { createChatSession, discardChatSessions, sessionContext, settle } from "./utils";

/**
 * A message's attachments read left to right in the order they were attached.
 *
 * The user's message sits on the right of the transcript, and keeping it there
 * once flipped the attachment row with `flex-row-reverse`, which reversed what
 * the reader sees: the second file appeared first.
 */

let sessionId = "";

const ATTACHMENTS = ["alpha.txt", "beta.txt"];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 375, height: 667 },
];

test.describe("chat attachment order", () => {
  test.beforeAll(async ({ request }) => {
    sessionId = await createChatSession(request, "attachment order");
    await seedAttachmentMessage(sessionId, ATTACHMENTS);
  });

  test.afterAll(async ({ request }) => {
    await clearTranscript(sessionId);
    await discardChatSessions(request, [sessionId]);
  });

  for (const { name, width, height } of VIEWPORTS) {
    test(`attachments keep the order they were attached in @ ${name}`, async ({ browser }) => {
      const ctx = await sessionContext(browser, { viewport: { width, height } });
      const page = await ctx.newPage();
      try {
        await page.goto(`/dashboard/chat/${sessionId}`, { waitUntil: "domcontentloaded" });
        await settle(page, { quietNetwork: true });

        const boxes = [];
        for (const file of ATTACHMENTS) {
          const chip = page
            .getByRole("button", { name: `Download ${file}` })
            .filter({ visible: true });
          await expect(chip).toBeVisible();
          boxes.push((await chip.boundingBox())!);
        }

        // Same row, in the order the files were attached.
        expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(4);
        expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
        // A user message hugs the right edge of the transcript.
        expect(boxes[1]!.x + boxes[1]!.width).toBeGreaterThan(width * 0.6);
      } finally {
        await ctx.close();
      }
    });
  }
});
