/**
 * The channel between this instance and a paired desktop agent.
 *
 * The agent dials out: it holds an SSE stream open for the messages Saale sends
 * it and posts its answers back. Both directions go through Redis, because the
 * process holding the agent's stream is not always the process running the
 * agent session that wants a screenshot (the web server, the worker running a
 * Telegram run, or a second replica).
 *
 * Channels per device:
 *
 *   `device:out:<id>`  server → agent, read by the SSE route
 *   `device:in:<id>`   agent → server, read by every process with a pending call
 *   `device:conn:<id>` presence, a TTL key the SSE route keeps alive
 */

import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { createRedisClient, getRedis } from "@/lib/redis";

const OUT_PREFIX = "device:out:";
const IN_PREFIX = "device:in:";
const CONN_PREFIX = "device:conn:";

/**
 * How long a connection counts as live without a refresh.
 *
 * The SSE route refreshes it on every heartbeat, so a process that dies stops
 * refreshing and its device reads as offline within this window instead of
 * forever.
 */
const CONNECTION_TTL_MS = 45_000;

const outChannel = (deviceId: string) => `${OUT_PREFIX}${deviceId}`;
const inChannel = (deviceId: string) => `${IN_PREFIX}${deviceId}`;
const connKey = (deviceId: string) => `${CONN_PREFIX}${deviceId}`;

/** Parse a published payload, dropping anything that is not a JSON-RPC message. */
function parseMessage(payload: string, deviceId: string): JsonRpcMessage | null {
  try {
    return parseJsonRpcMessage(JSON.parse(payload));
  } catch (err) {
    console.error(`Dropped a malformed message on the channel of device ${deviceId}:`, err);
    return null;
  }
}

/**
 * The notification that changes which tool groups an agent offers.
 *
 * A notification rather than a tool: the model must not be able to reach it, and
 * a switch the user flips in Saale is not a tool call. The agent applies it and
 * answers with a fresh hello, so the page shows what it actually took.
 */
export function groupsNotification(groups: readonly string[]): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/saale/groups",
    params: { groups: [...groups] },
  } as JsonRpcMessage;
}

/** Send one JSON-RPC message to an agent, through its open stream. */
export async function publishToDevice(deviceId: string, message: JsonRpcMessage): Promise<void> {
  await getRedis().publish(outChannel(deviceId), JSON.stringify(message));
}

/** Hand an agent's message to whichever process is waiting for it. */
export async function publishFromDevice(deviceId: string, message: JsonRpcMessage): Promise<void> {
  await getRedis().publish(inChannel(deviceId), JSON.stringify(message));
}

/**
 * Listen for what a device sends back, one shared subscriber per device per
 * process. Returns a detach that quits the subscriber when the last listener
 * goes.
 */
const inboxes = new Map<
  string,
  {
    client: ReturnType<typeof createRedisClient>;
    listeners: Set<(message: JsonRpcMessage) => void>;
  }
>();

export async function subscribeDeviceInbox(
  deviceId: string,
  listener: (message: JsonRpcMessage) => void,
): Promise<() => void> {
  let entry = inboxes.get(deviceId);

  if (!entry) {
    const client = createRedisClient();
    const listeners = new Set<(message: JsonRpcMessage) => void>();
    entry = { client, listeners };
    inboxes.set(deviceId, entry);

    client.on("message", (_channel: string, payload: string) => {
      const message = parseMessage(payload, deviceId);
      if (!message) return;
      for (const notify of listeners) notify(message);
    });
    client.on("error", (err: Error) => {
      console.error(`The device channel subscriber for ${deviceId} failed:`, err);
    });

    await client.subscribe(inChannel(deviceId)).catch((err: unknown) => {
      console.error(`Failed to subscribe to the channel of device ${deviceId}:`, err);
      inboxes.delete(deviceId);
      throw err;
    });
  }

  const current = entry;
  current.listeners.add(listener);

  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    inboxes.delete(deviceId);
    current.client.quit().catch((err: unknown) => {
      console.error(`Failed to close the device channel subscriber for ${deviceId}:`, err);
    });
  };
}

/** Listen for what Saale sends to a device. One subscriber per stream. */
export async function subscribeDeviceOutbox(
  deviceId: string,
  onMessage: (message: JsonRpcMessage) => void,
): Promise<() => void> {
  const client = createRedisClient();

  client.on("message", (_channel: string, payload: string) => {
    const message = parseMessage(payload, deviceId);
    if (message) onMessage(message);
  });
  client.on("error", (err: Error) => {
    console.error(`The outbound channel subscriber for device ${deviceId} failed:`, err);
  });

  await client.subscribe(outChannel(deviceId));

  return () => {
    client.quit().catch((err: unknown) => {
      console.error(`Failed to close the outbound channel of device ${deviceId}:`, err);
    });
  };
}

/** Mark a device's stream as open, and keep it open. */
export async function markDeviceConnected(deviceId: string, connectionId: string): Promise<void> {
  await getRedis()
    .set(connKey(deviceId), connectionId, "PX", CONNECTION_TTL_MS)
    .catch((err: unknown) => {
      console.error(`Failed to mark device ${deviceId} as connected:`, err);
    });
}

/** Drop the presence of a stream that closed, unless a newer one replaced it. */
export async function markDeviceDisconnected(
  deviceId: string,
  connectionId: string,
): Promise<void> {
  const redis = getRedis();
  const current = await redis.get(connKey(deviceId)).catch((err: unknown) => {
    console.error(`Failed to read the presence of device ${deviceId}:`, err);
    return null;
  });
  if (current !== null && current !== connectionId) return;
  await redis.del(connKey(deviceId)).catch((err: unknown) => {
    console.error(`Failed to clear the presence of device ${deviceId}:`, err);
  });
}

/** Whether an agent holds a stream to this instance right now. */
export async function isDeviceConnected(deviceId: string): Promise<boolean> {
  return (
    (await getRedis()
      .exists(connKey(deviceId))
      .catch((err: unknown) => {
        console.error(`Failed to read the presence of device ${deviceId}:`, err);
        return 0;
      })) === 1
  );
}
