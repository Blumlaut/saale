/**
 * The MCP transport of a paired device.
 *
 * MCP talks JSON-RPC; the agent's channel is one-way SSE down and plain POSTs
 * up. This class is the seam: `send` publishes onto the device's channel and
 * every message the agent posts back arrives through `onMessage`, which is what
 * the MCP client correlates its requests against. Timeouts are the client's.
 */

import type {
  JsonRpcMessage,
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
  McpTransportSendOptions,
} from "@earendil-works/pi-mcp";
import { publishToDevice, subscribeDeviceInbox } from "./channel";

export interface DeviceTransportChannel {
  /** Server → agent. */
  publish(deviceId: string, message: JsonRpcMessage): Promise<void>;
  /** Agent → server. Resolves to a detach. */
  subscribe(deviceId: string, listener: (message: JsonRpcMessage) => void): Promise<() => void>;
}

const redisChannel: DeviceTransportChannel = {
  publish: publishToDevice,
  subscribe: subscribeDeviceInbox,
};

export class DeviceTransport implements McpTransport {
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  private detach: (() => void) | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly deviceId: string,
    private readonly channel: DeviceTransportChannel = redisChannel,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.detach = await this.channel.subscribe(this.deviceId, (message) => {
      for (const listener of this.messageListeners) listener(message);
    });
  }

  async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
    if (this.closed) throw new Error(`The channel of device ${this.deviceId} is closed`);
    if (options?.signal?.aborted) return;
    try {
      await this.channel.publish(this.deviceId, message);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Failed to reach device ${this.deviceId}:`, error);
      for (const listener of this.errorListeners) listener(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.detach = null;
    for (const listener of this.closeListeners) listener();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}
