import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { attachShell, type ShellEvent } from "@/lib/terminal/shell-sessions";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { isClosedControllerError } from "@/lib/pi/sse-controller";
import { formatSseEvent } from "@/lib/pi/stream-logic";

/**
 * GET /api/terminal/stream?target=. follow a shell's output.
 *
 * Server-sent events because a shell prints for as long as it is open, and this
 * connection is only a reader: closing it stops nothing. What the shell printed
 * before the reader arrived is replayed first, so reopening the tab shows the
 * session it left.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Quiet enough for an idle shell, busy enough that a proxy keeps the pipe. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;
  const target = request.nextUrl.searchParams.get("target") ?? "";

  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        heartbeat.stop();
        try {
          controller.close();
        } catch (err) {
          // Already closed by the runtime.
          if (!isClosedControllerError(err)) {
            console.warn(`Terminal stream for ${target} failed to close:`, err);
          }
        }
      };

      const send = (event: string, payload: ShellEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
        } catch (err) {
          detach?.();
          finish();
          // The reader left; the shell carries on without it.
          if (!isClosedControllerError(err)) {
            console.warn(`Terminal stream for ${target} failed to send ${event}:`, err);
          }
        }
      };

      const attachment = attachShell(userId, target, (event) => {
        send(event.type, event);
        if (event.type === "closed") finish();
      });

      // No shell to show: an idle connection would only keep a proxy waiting.
      if (!attachment) {
        finish();
        return;
      }

      detach = attachment.detach;
      if (!attachment.live) finish();
    },
    cancel() {
      detach?.();
      detach = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
