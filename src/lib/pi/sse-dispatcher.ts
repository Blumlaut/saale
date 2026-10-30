/**
 * Per-session SSE fan-out dispatcher.
 *
 * Unlike the old single-slot dispatcher (where a new connection closed the
 * previous one, causing reconnect ping-pong between tabs), this dispatcher
 * supports any number of concurrent clients per session. every open tab or
 * reconnect observes the same live stream.
 *
 * Lifecycle of a client:
 *   1. `subscribe(controller, encoder, lastEventId)` registers the client,
 *      subscribes to the session's pub/sub bus, then replays buffered events.
 *      The per-client `seenIds` set dedupes the overlap between live
 *      delivery (which may arrive during the replay) and the replay itself,
 *      so no event is lost or delivered twice.
 *   2. Live events are fanned out to every registered client.
 *   3. `unsubscribe(controller)` drops the client; when the last client
 *      leaves, the bus subscription is released.
 *
 * Events are published by the session event tracker (via
 * `publishSessionEvent`); this dispatcher never buffers. it is a pure
 * fan-out hub.
 */

import { getLiveRunEvents } from "./sse-buffer";
import { isClosedControllerError } from "./sse-controller";
import { subscribeSessionEvents, type SessionStreamEvent } from "./session-events";
import { formatSseEvent } from "./stream-logic";

interface SseClient {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  /**
   * IDs this client has already received (dedupes the replay/live overlap).
   *
   * A bounded set instead of a monotonic watermark: if the Redis counter ever
   * resets (counter TTL expiry after a very long idle tool, Redis data loss),
   * fresh events would carry low IDs and a watermark-based dedupe would
   * silently drop them all. the client freezes while Pi keeps working. A set
   * only skips what was actually seen, so post-reset events still flow.
   */
  seenIds: Set<number>;
}

/**
 * Cap on per-client seen IDs before the set is cleared.
 *
 * Small on purpose: the only real dedupe need is the replay/live overlap
 * during `subscribe` (a few ms. a handful of events). Keeping the set small
 * means stale history from before a Redis restart / counter reset is
 * forgotten quickly, so post-reset events (which reuse low IDs) still flow.
 * A cleared set can at worst re-deliver an event, and every client handler is
 * idempotent (cumulative token text, text deltas keyed by the offset they
 * continue from, tool_start deduped by toolCallId, message_saved mapped by ID).
 * harmless.
 */
const MAX_SEEN_IDS = 200;

export class SseDispatcher {
  private clients = new Map<ReadableStreamDefaultController, SseClient>();
  private unsubBus: (() => void) | null = null;
  /** In-flight bus subscription, shared by clients connecting at the same time. */
  private busPending: Promise<() => void> | null = null;

  constructor(private readonly sessionId: string) {}

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Register a client. Replays buffered events after `lastEventId`, then
   * forwards live events. Safe to call concurrently for many clients.
   *
   * The bus subscription is established BEFORE reading the buffer, so events
   * published in between are either received live or included in the replay
   *. never lost. `seenIds` dedupes the overlap.
   */
  async subscribe(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    lastEventId: number,
  ): Promise<void> {
    if (this.clients.has(controller)) return;

    const client: SseClient = { controller, encoder, seenIds: new Set() };
    this.clients.set(controller, client);

    await this.ensureBusSubscription();
    if (!this.clients.has(controller)) return;

    // Only the run still in flight: a finished one is already in the DB and
    // replaying it would rebuild it on top of itself (see `liveRunEvents`).
    const buffered = await getLiveRunEvents(this.sessionId, lastEventId).catch((err) => {
      console.error(`Failed to read SSE buffer for session ${this.sessionId}:`, err);
      return [] as SessionStreamEvent[];
    });
    for (const evt of buffered) {
      this.forward(evt, client);
    }
  }

  /** Drop a client (client disconnected). */
  unsubscribe(controller: ReadableStreamDefaultController): void {
    this.clients.delete(controller);
    if (this.clients.size === 0 && this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
  }

  /**
   * Hold the session's bus subscription for as long as a client is registered.
   *
   * Concurrent connects share one subscription, and one that is set up after
   * its last client left is released again so it cannot outlive the client.
   */
  private async ensureBusSubscription(): Promise<void> {
    if (this.unsubBus) return;

    const pending = (this.busPending ??= subscribeSessionEvents(this.sessionId, (evt) =>
      this.forward(evt),
    ));
    const unsub = await pending;
    if (this.busPending === pending) this.busPending = null;

    // Another client's connect may have installed it while we waited.
    if (this.unsubBus) return;
    if (this.clients.size === 0) {
      unsub();
      return;
    }
    this.unsubBus = unsub;
  }

  /**
   * Send an event to a single client without buffering it.
   *
   * Used for terminal "done" on idle connects. we don't want to persist a
   * done event that would poison the buffer for the next generation.
   */
  emitLocal(controller: ReadableStreamDefaultController, event: string, data: unknown): void {
    const client = this.clients.get(controller);
    if (!client) return;
    this.enqueue(client, event, data);
  }

  /**
   * Release all clients and the bus subscription (session evicted/deleted).
   *
   * Closing the controllers makes the clients' EventSources reconnect, which
   * re-subscribes them to a fresh dispatcher. self-healing instead of
   * silently stalling.
   */
  async dispose(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        client.controller.close();
      } catch {
        // Already closed. ignore
      }
    }
    this.clients.clear();
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
    // A subscription still being set up is released by `ensureBusSubscription`
    // once it settles, since no client is left by then.
    await this.busPending;
  }

  /** Forward a live or replayed event to a client (or all clients). */
  private forward(evt: SessionStreamEvent, only?: SseClient): void {
    const targets = only ? [only] : [...this.clients.values()];
    for (const client of targets) {
      // An enqueue failure earlier in this pass may have dropped the client.
      if (this.clients.get(client.controller) !== client) continue;
      // Negative IDs only occur when buffering failed. always forward them.
      // Otherwise skip only what this client has genuinely seen already.
      if (evt.id >= 0 && client.seenIds.has(evt.id)) continue;
      client.seenIds.add(evt.id);
      this.pruneSeenIds(client);
      this.enqueue(client, evt.event, evt.data, evt.id);
    }
  }

  /**
   * Bound the seen-ID set. When it overflows we clear it: a re-delivered
   * event would at worst double-fire a client handler, and every handler is
   * idempotent (cumulative token text, text deltas keyed by the offset they
   * continue from, tool_start deduped by toolCallId). harmless. This keeps
   * long sessions from growing the set forever.
   */
  private pruneSeenIds(client: SseClient): void {
    if (client.seenIds.size > MAX_SEEN_IDS) {
      client.seenIds.clear();
    }
  }

  private enqueue(client: SseClient, event: string, data: unknown, id?: number): void {
    try {
      client.controller.enqueue(client.encoder.encode(formatSseEvent(event, data, id)));
    } catch (err) {
      // The controller is closed, so this client is gone. Drop it before the
      // next event logs the same failure (the runtime often never reports the
      // disconnect through `cancel()` or the request signal).
      if (isClosedControllerError(err)) {
        this.unsubscribe(client.controller);
        return;
      }
      console.error(`Failed to enqueue SSE event "${event}" for session ${this.sessionId}:`, err);
    }
  }
}
