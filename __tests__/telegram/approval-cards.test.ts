import { describe, expect, it, vi } from "vitest";
import { createApprovalCardTracker } from "@/lib/telegram/approval-cards";

describe("createApprovalCardTracker", () => {
  it("deletes the card when the approval resolves", () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    expect(tracker.pendingCount).toBe(1);

    tracker.onResolved("tool-1");
    expect(tracker.pendingCount).toBe(0);
    expect(deleteCard).toHaveBeenCalledTimes(1);
    expect(deleteCard).toHaveBeenCalledWith({ chatId: 42, messageId: 101 });
  });

  it("ignores resolutions for tool calls that never had a card", () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    tracker.onResolved("tool-2"); // never sent a card
    expect(deleteCard).not.toHaveBeenCalled();
    expect(tracker.pendingCount).toBe(1);
  });

  it("onResolved is idempotent  double resolution deletes exactly once", () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    tracker.onResolved("tool-1");
    tracker.onResolved("tool-1");

    expect(deleteCard).toHaveBeenCalledTimes(1);
    expect(tracker.pendingCount).toBe(0);
  });

  it("flush deletes all outstanding cards at run end", () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    tracker.track("tool-2", { chatId: 42, messageId: 102 });

    // One resolves during the run, the other is still pending at run end.
    tracker.onResolved("tool-1");
    tracker.flush();

    expect(deleteCard).toHaveBeenCalledTimes(2);
    expect(deleteCard).toHaveBeenNthCalledWith(1, { chatId: 42, messageId: 101 });
    expect(deleteCard).toHaveBeenNthCalledWith(2, { chatId: 42, messageId: 102 });
    expect(tracker.pendingCount).toBe(0);

    // After flush, late resolutions are no-ops.
    tracker.onResolved("tool-2");
    expect(deleteCard).toHaveBeenCalledTimes(2);
  });

  it("re-tracking a tool call replaces the old card  only the latest is deleted", () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    tracker.track("tool-1", { chatId: 42, messageId: 202 }); // card resent
    tracker.flush();

    expect(deleteCard).toHaveBeenCalledTimes(1);
    expect(deleteCard).toHaveBeenCalledWith({ chatId: 42, messageId: 202 });
  });

  it("swallows delete failures (logs, never throws)", () => {
    const deleteCard = vi
      .fn()
      .mockRejectedValue(new Error("Bad Request: message to delete not found"));
    const tracker = createApprovalCardTracker(deleteCard);

    tracker.track("tool-1", { chatId: 42, messageId: 101 });
    expect(() => tracker.onResolved("tool-1")).not.toThrow();
    expect(tracker.pendingCount).toBe(0);
  });
});
