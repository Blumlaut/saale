/** Chat + message location of a Telegram approval card. */
export interface ApprovalCardId {
  chatId: number;
  messageId: number;
}

/**
 * Tracks Telegram approval cards sent during a run and deletes them when
 * the approval resolves (button press, timeout, interrupt) or when the run
 * ends with cards still outstanding.
 *
 * The card is owned by the run that sent it: the session bus publishes
 * `tool_approval_resolved` for every resolution path (Telegram button, web
 * UI, approval timeout, abort), so this tracker is the single deletion
 * point. no card is left behind for a resolution that never got a button
 * press.
 *
 * `deleteCard` is injected for testability. Deletion is fire-and-forget;
 * errors are logged, never thrown.
 */
export function createApprovalCardTracker(deleteCard: (cardId: ApprovalCardId) => Promise<void>) {
  const cards = new Map<string, ApprovalCardId>();

  /** Delete a card, logging the expected "already deleted" race as a warning. */
  function remove(toolCallId: string, cardId: ApprovalCardId): void {
    void deleteCard(cardId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found") || message.includes("already deleted")) {
        // Expected when the card was removed out-of-band (e.g. chat cleanup).
        console.warn(`Telegram approval card for ${toolCallId} could not be deleted:`, message);
      } else {
        console.error(`Failed to delete Telegram approval card for ${toolCallId}:`, err);
      }
    });
  }

  return {
    /** Register a card that was sent for the given tool call. */
    track(toolCallId: string, cardId: ApprovalCardId): void {
      cards.set(toolCallId, cardId);
    },

    /**
     * Called when an approval resolves (any resolution path). Deletes the
     * card if one was sent for this tool call. Safe to call for tool calls
     * that never had a card.
     */
    onResolved(toolCallId: string): void {
      const cardId = cards.get(toolCallId);
      if (!cardId) return;
      cards.delete(toolCallId);
      remove(toolCallId, cardId);
    },

    /**
     * Run end: delete any cards still outstanding (e.g. a denial that raced
     * with the run finishing, or a bus event that was missed).
     */
    flush(): void {
      for (const [toolCallId, cardId] of cards) {
        cards.delete(toolCallId);
        remove(toolCallId, cardId);
      }
    },

    /** Number of cards currently tracked (for tests/diagnostics). */
    get pendingCount(): number {
      return cards.size;
    },
  };
}
