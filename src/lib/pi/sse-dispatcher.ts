/**
 * Per-session SSE fan-out dispatcher.
 *
 * Unlike the old single-slot dispatcher (where a new connection closed the
 * previous one, causing reconnect ping-pong between tabs), this dispatcher
 * supports any number of concurrent clients per session — every open tab or
 * reconnect observes the same live stream.
 *
 * Lifecycle of a client:
 *   1. `subscribe(controller, encoder, lastEventId)` registers the client,
 *      subscribes to the session's pub/sub bus, then replays buffered events.
 *      The per-client `nextExpectedId` dedupes the overlap between live
 *      delivery (which may arrive during the replay) and the replay itself,
 *      so no event is lost or delivered twice.
 *   2. Live events are fanned out to every registered client.
 *   3. `unsubscribe(controller)` drops the client; when the last client
 *      leaves, the bus subscription is released.
 *
 * Events are published by the session event tracker (via
 * `publishSessionEvent`); this dispatcher never buffers — it is a pure
 * fan-out hub.
 */

import { getBufferedEvents } from "./sse-buffer";
import { subscribeSessionEvents, type SessionStreamEvent } from "./session-events";

/**
 * Format an SSE event. `id` is optional — unbuffered terminal events (e.g.
 * an idle "done") omit it so they don't disturb the client's Last-Event-ID.
 */
function formatSseEvent(event: string, data: unknown, id?: number): string {
  const json = JSON.stringify(data);
  const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${escaped}\n\n`;
}

interface SseClient {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  /** Lowest event ID this client still needs (dedupe replay/live overlap). */
  nextExpectedId: number;
}

export class SseDispatcher {
  private clients = new Map<ReadableStreamDefaultController, SseClient>();
  private unsubBus: (() => void) | null = null;

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
   * — never lost. `nextExpectedId` dedupes the overlap.
   */
  async subscribe(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    lastEventId: number,
  ): Promise<void> {
    if (this.clients.has(controller)) return;

    const client: SseClient = { controller, encoder, nextExpectedId: lastEventId + 1 };
    this.clients.set(controller, client);

    if (!this.unsubBus) {
      this.unsubBus = await subscribeSessionEvents(this.sessionId, (evt) => this.forward(evt));
    }

    const buffered = await getBufferedEvents(this.sessionId, lastEventId).catch((err) => {
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
   * Send an event to a single client without buffering it.
   *
   * Used for terminal "done" on idle connects — we don't want to persist a
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
   * re-subscribes them to a fresh dispatcher — self-healing instead of
   * silently stalling.
   */
  async dispose(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        client.controller.close();
      } catch {
        // Already closed — ignore
      }
    }
    this.clients.clear();
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
  }

  /** Forward a live or replayed event to a client (or all clients). */
  private forward(evt: SessionStreamEvent, only?: SseClient): void {
    const targets = only ? [only] : [...this.clients.values()];
    for (const client of targets) {
      // Negative IDs only occur when buffering failed — always forward them.
      // Otherwise skip anything already delivered via replay or an earlier
      // live event.
      if (evt.id >= 0 && evt.id < client.nextExpectedId) continue;
      client.nextExpectedId = Math.max(client.nextExpectedId, evt.id + 1);
      this.enqueue(client, evt.event, evt.data, evt.id);
    }
  }

  private enqueue(client: SseClient, event: string, data: unknown, id?: number): void {
    try {
      client.controller.enqueue(client.encoder.encode(formatSseEvent(event, data, id)));
    } catch (err) {
      console.error(`Failed to enqueue SSE event "${event}" for session ${this.sessionId}:`, err);
    }
  }
}
