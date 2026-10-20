import type { NextRequest } from "next/server";
import { councilCaller } from "@/lib/council/http";
import { getCouncil } from "@/lib/council/store";
import { SseDispatcher } from "@/lib/pi/sse-dispatcher";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { formatSseEvent } from "@/lib/pi/stream-logic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Long enough to survive a quiet stretch (a member thinking for a minute) and
 * short enough that a proxy does not decide the connection is dead.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * GET /api/council/[councilId]/stream. the room's live events.
 *
 * Carries what a repaint needs, not the room itself: `message` means "the room
 * moved, fetch it", and the thinking/tool-call events are for the members' live
 * state. The client rebuilds the room from the REST route, so a reconnecting tab
 * cannot end up with a room that only exists in its own event replay.
 *
 * The bus is the chat stream's, keyed by the council id. cross-process publish,
 * monotonic event ids and a replay buffer for `Last-Event-ID`, all without a
 * second implementation of the same thing.
 *
 * Deliberately not per-agent: one connection per open room, not one per member.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const council = await getCouncil(caller.userId, councilId);
  if (!council) return new Response("Not found", { status: 404 });

  const encoder = new TextEncoder();
  const dispatcher = new SseDispatcher(councilId);
  const lastEventId = Number.parseInt(request.headers.get("last-event-id") ?? "0", 10) || 0;

  let heartbeat: ReturnType<typeof createSseHeartbeat> | null = null;
  // `cancel` receives the reason, not the controller, so the subscription is
  // released through a reference kept from `start`.
  let streamController: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      streamController = controller;
      // Subscribing replays buffered events for `lastEventId`, so a reconnect
      // sees what it missed before the live events start flowing.
      await dispatcher.subscribe(controller, encoder, lastEventId);
      heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);

      // Lets the client mark itself connected without waiting for an event.
      try {
        controller.enqueue(
          encoder.encode(
            formatSseEvent("ready", {
              councilId,
              status: council.status,
              lastSeq: council.lastSeq,
            }),
          ),
        );
      } catch (err) {
        console.error(`Failed to send the council stream's ready event for ${councilId}:`, err);
      }
    },
    cancel() {
      heartbeat?.stop();
      if (streamController) dispatcher.unsubscribe(streamController);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
