import type { QueuedChatMessage } from "@/lib/chat/serialize-message";

/**
 * Send-queue drain loop.
 *
 * Runs when a generation settles (and when an idle session reconnects): every
 * message the user queued while Pi was working is delivered, in order, as its
 * own run.
 *
 * Deliberately dependency-injected. the caller owns the agent (prompting,
 * persistence wiring, stream teardown), this owns the queue's semantics:
 * stop while a run is in flight, never claim a message that cannot be handed
 * to the agent, and never drop one (a failed hand-off goes back to the queue).
 */

export interface DrainDeps {
  /** True while this process is already running a prompt for the session. */
  isPromptInFlight: () => boolean;
  /** Atomically take the oldest queued message, or null when the queue is empty. */
  claimNext: () => Promise<QueuedChatMessage | null>;
  /**
   * Hand the message to the agent. Returns false when nothing was attempted
   * (the message must go back to the queue); true when it was delivered
   * including a run that then failed, which is persisted as a failed turn.
   */
  run: (message: QueuedChatMessage) => Promise<boolean>;
  /** Put a claimed message back at its original queue position. */
  restore: (message: QueuedChatMessage) => Promise<void>;
  /** Publish the queue's new state to connected clients. */
  publishQueue: () => Promise<void>;
  log?: (message: string) => void;
}

/** @returns how many queued messages were delivered. */
export async function drainSendQueue(deps: DrainDeps): Promise<number> {
  let delivered = 0;

  for (;;) {
    if (deps.isPromptInFlight()) return delivered;

    const message = await deps.claimNext();
    if (!message) return delivered;

    if (await deps.run(message)) {
      delivered++;
      continue;
    }

    // The claim succeeded but nothing could run. a rare race (another
    // connection started a prompt in between). Put the message back and stop:
    // the run that is now in flight drains the queue when it settles.
    deps.log?.(`could not deliver queued message ${message.id}. requeued`);
    await deps.restore(message);
    await deps.publishQueue();
    return delivered;
  }
}
