/**
 * SSE dispatcher that maintains exactly one active connection per session.
 *
 * Key properties:
 * - Only one controller is wired at a time (new replaces old atomically)
 * - Every event gets a monotonically increasing ID via Redis
 * - Events are buffered to Redis for replay on reconnect
 * - SSE format includes `id:` field for Last-Event-ID support
 *
 * This replaces the old StreamDispatcher which had no event IDs and
 * allowed multiple simultaneous connections.
 */

import { bufferEvent, clearBuffer } from "./sse-buffer";

/**
 * Format an SSE event with id field for Last-Event-ID support.
 *
 * The SSE spec requires:
 * - `id:` field sets the last event ID on the client
 * - `event:` field names the event type
 * - `data:` field contains the JSON payload
 * - Double newline terminates the event block
 */
function formatSseEvent(event: string, data: unknown, id: number): string {
  const json = JSON.stringify(data);
  const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `id: ${id}\nevent: ${event}\ndata: ${escaped}\n\n`;
}

/**
 * SSE dispatcher for a single chat session.
 *
 * Usage:
 * 1. Create via getDispatcher(sessionId) from agent-pool
 * 2. Wire controller inside ReadableStream's start() callback
 * 3. Call emit() for each agent event
 * 4. Call cleanup() when stream ends
 */
export class SseDispatcher {
  private controller: ReadableStreamDefaultController | null = null;
  private encoder: TextEncoder | null = null;
  private closed = false;

  constructor(private readonly sessionId: string) {}

  /**
   * Wire the SSE controller. Replaces any existing connection atomically.
   * Called inside ReadableStream's start() callback.
   */
  wire(controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
    // Close old connection gracefully if it exists
    if (this.controller && !this.closed) {
      try {
        this.controller.close();
      } catch {
        // Already closed — ignore
      }
    }

    this.controller = controller;
    this.encoder = encoder;
    this.closed = false;
  }

  /**
   * Emit an SSE event with an ID.
   * Buffers to Redis AND sends to the active controller.
   */
  async emit(event: string, data: unknown): Promise<void> {
    // Buffer to Redis (gets event ID)
    const eventId = await bufferEvent(this.sessionId, event, data).catch((err) => {
      console.error(`Failed to buffer SSE event ${event} for ${this.sessionId}:`, err);
      return -1; // Fallback: use -1 as ID (will still work, just breaks Last-Event-ID tracking)
    });

    // Send to active SSE connection
    if (this.encoder && this.controller && !this.closed) {
      const payload = formatSseEvent(event, data, eventId);
      try {
        this.controller.enqueue(this.encoder.encode(payload));
      } catch (err) {
        console.error(`Failed to enqueue SSE event ${event} for ${this.sessionId}:`, err);
      }
    }
  }

  /**
   * Emit an SSE event synchronously (no buffering, no ID).
   * Used for buffered replay where events already have IDs from Redis.
   */
  emitSync(event: string, data: unknown, id: number): void {
    if (!this.encoder || !this.controller || this.closed) return;

    const payload = formatSseEvent(event, data, id);
    try {
      this.controller.enqueue(this.encoder.encode(payload));
    } catch (err) {
      console.error(`Failed to enqueue buffered SSE event ${event} for ${this.sessionId}:`, err);
    }
  }

  /**
   * Mark the dispatcher as closed (client disconnected or stream ended).
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Clean up the buffer when stream ends.
   * Call this after emitting the final `done` event.
   */
  async cleanup(): Promise<void> {
    this.closed = true;
    await clearBuffer(this.sessionId);
  }

  /** Whether the dispatcher is currently closed. */
  get isClosed(): boolean {
    return this.closed;
  }
}
