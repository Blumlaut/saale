import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseJsonRpcMessage, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { authenticateDevice } from "@/lib/devices/auth";
import {
  markDeviceConnected,
  markDeviceDisconnected,
  publishFromDevice,
  subscribeDeviceOutbox,
} from "@/lib/devices/channel";
import { recordDeviceConnect } from "@/lib/devices/store";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { isClosedControllerError } from "@/lib/pi/sse-controller";
import { formatSseEvent } from "@/lib/pi/stream-logic";

/**
 * The channel a paired agent holds open.
 *
 * GET streams the JSON-RPC messages Saale sends the machine. POST carries what
 * the machine sends back, and its hello. Both are authenticated by the agent's
 * own token, and neither is a browser route.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Presence is refreshed on this tick, so a stream that died reads as offline
 * within the channel's TTL. The same tick keeps a proxy from closing an idle
 * stream.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** How many messages one POST may carry. A batch is a burst of answers, not a dump. */
const MAX_MESSAGES_PER_POST = 50;

/** GET /api/devices/channel. the agent's stream. */
export async function GET(request: NextRequest) {
  const authResult = await authenticateDevice(request);
  if (!authResult.ok) return authResult.response;
  const device = authResult.device;

  const connectionId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        heartbeat.stop();
        clearInterval(presence);
        detach?.();
        detach = null;
        void markDeviceDisconnected(device.id, connectionId);
        try {
          controller.close();
        } catch (err) {
          if (!isClosedControllerError(err)) {
            console.error(`The channel of device ${device.id} failed to close:`, err);
          }
        }
      };

      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
        } catch (err) {
          if (!isClosedControllerError(err)) {
            console.error(`The channel of device ${device.id} failed to send ${event}:`, err);
          }
          finish();
        }
      };

      const presence = setInterval(() => {
        void markDeviceConnected(device.id, connectionId);
      }, SSE_HEARTBEAT_INTERVAL_MS);

      await markDeviceConnected(device.id, connectionId);
      await recordDeviceConnect(device.id, {});

      try {
        detach = await subscribeDeviceOutbox(device.id, (message) => {
          send("message", message);
        });
      } catch (err) {
        console.error(`Failed to open the channel of device ${device.id}:`, err);
        finish();
        return;
      }

      // Tells the agent the stream is live, so it can drop its reconnect backoff.
      send("ready", { deviceId: device.id, connectionId });
    },
    cancel() {
      detach?.();
      detach = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** POST /api/devices/channel. what the agent sends back, and its hello. */
export async function POST(request: NextRequest) {
  const authResult = await authenticateDevice(request);
  if (!authResult.ok) return authResult.response;
  const device = authResult.device;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const hello = body.hello as Record<string, unknown> | undefined;
  if (hello) {
    await recordDeviceConnect(device.id, {
      capabilities: hello.capabilities,
      agentVersion: typeof hello.agentVersion === "string" ? hello.agentVersion : undefined,
      session: typeof hello.session === "string" ? hello.session : undefined,
      platform: typeof hello.platform === "string" ? hello.platform : undefined,
    });
  }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  if (raw.length > MAX_MESSAGES_PER_POST) {
    return NextResponse.json({ error: "Too many messages" }, { status: 413 });
  }

  const messages: JsonRpcMessage[] = [];
  for (const item of raw) {
    try {
      messages.push(parseJsonRpcMessage(item));
    } catch (err) {
      console.error(`Device ${device.id} sent a malformed message:`, err);
      return NextResponse.json({ error: "Malformed message" }, { status: 400 });
    }
  }

  for (const message of messages) await publishFromDevice(device.id, message);

  return NextResponse.json({ ok: true, accepted: messages.length });
}
