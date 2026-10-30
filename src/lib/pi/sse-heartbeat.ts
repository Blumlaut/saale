/**
 * Periodic SSE ping for a single client connection.
 *
 * During a long tool call no stream events flow for minutes, so an SSE
 * connection is completely idle. Idle-sniffing intermediaries (nginx
 * proxy_read_timeout, Cloudflare, load balancers) would kill it. A periodic
 * ping keeps the connection alive AND gives the client a liveness signal:
 * its watchdog force-reconnects when pings stop arriving.
 *
 * The ping is unbuffered and carries no `id:` line, so it never disturbs
 * Last-Event-ID reconnection or the replay dedupe.
 *
 * The heartbeat stops itself if the controller is ever closed underneath it
 * (client disconnect, stream cancelled by the runtime) instead of throwing
 * ERR_INVALID_STATE on every tick. Callers should still call `stop()` from
 * their own teardown hooks (ReadableStream `cancel()`, abort listeners) so
 * the interval is cleared immediately; the self-stop is a race fallback for
 * teardowns the runtime never reports.
 */

import { isClosedControllerError } from "./sse-controller";

export interface SseHeartbeat {
  /** Stop the ping loop. Safe to call multiple times. */
  stop(): void;
}

export function createSseHeartbeat(
  controller: ReadableStreamDefaultController,
  intervalMs: number,
  now: () => number = Date.now,
): SseHeartbeat {
  let stopped = false;
  const encoder = new TextEncoder();

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      controller.enqueue(encoder.encode(`event: ping\ndata: {"t":${now()}}\n\n`));
    } catch (err) {
      // The controller is already closed. the stream was torn down while
      // this tick was in flight (client disconnected). Stop ticking instead
      // of throwing on a closed controller every interval. This is an
      // expected lifecycle race, not an error. swallow it like the
      // `stopped` early-exit guard above.
      if (isClosedControllerError(err)) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      console.error("Failed to enqueue SSE heartbeat:", err);
    }
  }, intervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
