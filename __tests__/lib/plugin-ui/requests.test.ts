import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Requests live in Redis and settle over its pub/sub bus. the in-memory stand-in.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
import { resetMockRedis } from "../../helpers/in-memory-redis";
import {
  getPendingPluginUiRequests,
  getPendingPluginUiRequestsForUser,
  PLUGIN_UI_MAX_PENDING,
  requestPluginUi,
  resolvePluginUiRequest,
  type PluginUiRequestInput,
} from "@/lib/plugin-ui/requests";

/**
 * A session id per test: the bus is process-wide, so a resolution event from
 * one test would settle the next test's wait on the same session.
 */
let sessionSeq = 0;
function base(): PluginUiRequestInput {
  sessionSeq += 1;
  return {
    sessionId: `session-${sessionSeq}`,
    userId: "user-1",
    kind: "confirm",
    title: "Allow the deploy?",
  };
}

describe("plugin UI requests", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists a waiting dialog and settles it with the answer", async () => {
    const input = base();
    const promise = requestPluginUi(input);
    await vi.waitFor(async () => {
      expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(1);
    });

    const [pending] = await getPendingPluginUiRequests(input.sessionId);
    await resolvePluginUiRequest(input.sessionId, pending!.id, { confirmed: true });

    await expect(promise).resolves.toEqual({ confirmed: true });
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(0);
  });

  it("keeps the first answer when a second client also answers", async () => {
    const input = { ...base(), kind: "input" as const };
    const promise = requestPluginUi(input);
    const [pending] = await vi.waitFor(async () => {
      const listed = await getPendingPluginUiRequests(input.sessionId);
      expect(listed).toHaveLength(1);
      return listed;
    });

    expect(await resolvePluginUiRequest(input.sessionId, pending!.id, { value: "yes" })).toBe(true);
    expect(await resolvePluginUiRequest(input.sessionId, pending!.id, { value: "no" })).toBe(false);
    await expect(promise).resolves.toEqual({ value: "yes" });
  });

  it("lets one of two answers arriving together win", async () => {
    const input = { ...base(), kind: "input" as const };
    const promise = requestPluginUi(input);
    const [pending] = await vi.waitFor(async () => {
      const listed = await getPendingPluginUiRequests(input.sessionId);
      expect(listed).toHaveLength(1);
      return listed;
    });

    // A Telegram tap and a click in the chat, in the same instant.
    const results = await Promise.all([
      resolvePluginUiRequest(input.sessionId, pending!.id, { value: "from the chat" }),
      resolvePluginUiRequest(input.sessionId, pending!.id, { value: "from telegram" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(promise).resolves.toEqual({ value: "from the chat" });
  });

  it("answers an unknown id with false", async () => {
    expect(await resolvePluginUiRequest(base().sessionId, "nope", { cancelled: true })).toBe(false);
  });

  it("cancels at the deadline when nobody answers", async () => {
    vi.useFakeTimers();
    const input = { ...base(), kind: "select" as const, options: ["a", "b"] };
    const promise = requestPluginUi(input, { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(0);
  });

  it("cancels when the run is stopped", async () => {
    const input = base();
    const controller = new AbortController();
    const promise = requestPluginUi(input, { signal: controller.signal });

    await vi.waitFor(async () => {
      expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(1);
    });
    controller.abort();

    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(0);
  });

  it("refuses a dialog beyond the session's cap", async () => {
    const input = base();
    const waiting = Array.from({ length: PLUGIN_UI_MAX_PENDING }, (_, index) =>
      requestPluginUi({ ...input, title: `dialog ${index}` }),
    );
    await vi.waitFor(async () => {
      expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(PLUGIN_UI_MAX_PENDING);
    });

    // A plugin in a loop must not be able to bury the chat in cards.
    await expect(requestPluginUi({ ...input, title: "one too many" })).resolves.toEqual({
      cancelled: true,
    });
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(PLUGIN_UI_MAX_PENDING);

    for (const pending of await getPendingPluginUiRequests(input.sessionId)) {
      await resolvePluginUiRequest(input.sessionId, pending.id, { cancelled: true });
    }
    await Promise.all(waiting);
  });

  it("keeps each user's dialogs to their own chats", async () => {
    const mine = base();
    const theirs = { ...base(), userId: "user-2" };
    const first = requestPluginUi(mine);
    const second = requestPluginUi(theirs);

    await vi.waitFor(async () => {
      expect(await getPendingPluginUiRequestsForUser("user-1")).toHaveLength(1);
      expect(await getPendingPluginUiRequestsForUser("user-2")).toHaveLength(1);
    });

    const [entry] = await getPendingPluginUiRequestsForUser("user-1");
    expect(entry!.sessionId).toBe(mine.sessionId);

    for (const [input, answer] of [
      [mine, first],
      [theirs, second],
    ] as const) {
      const [pending] = await getPendingPluginUiRequests(input.sessionId);
      await resolvePluginUiRequest(input.sessionId, pending!.id, { cancelled: true });
      await answer;
    }
  });
});
