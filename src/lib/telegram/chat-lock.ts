/**
 * Per-chat serialization for Telegram processing.
 *
 * Telegram delivers updates for a chat one at a time, but the webhook
 * acknowledges each one and processes it in the background, so two messages
 * arriving in quick succession are processed concurrently. Overlapping runs
 * share a chat's transcript directory, and the first message of a chat can
 * even create two `ChatSession` rows (both runs read "no chat yet" before
 * either writes), leaving the reply in a session the chat is no longer
 * linked to.
 *
 * Serializing on the chat key keeps one run per chat at a time. Latest
 * message wins: the webhook supersedes the active run before calling in, and
 * a run whose message was superseded while it sat in this queue bails out at
 * its checkpoints (see `isLatestMessage`) instead of running to completion.
 */

type Lock = Promise<void>;

const locks = new Map<string, Lock>();

/**
 * Run `fn` after every previously queued run for `key` has settled.
 *
 * @param key - Chat identity (`${userId}:${telegramChatId}`).
 * @param fn - The work to run exclusively for that key.
 */
export function withChatLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();

  // A failed predecessor must not skip the queued work.
  const run = previous.then(fn, fn);

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.finally(() => {
    // Only the last queued run clears the entry; a run queued in the meantime
    // has already replaced it.
    if (locks.get(key) === tail) locks.delete(key);
  });

  return run;
}

/** Number of chats with queued work (test/debug helper). */
export function pendingChatLocks(): number {
  return locks.size;
}
