import { describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { DeviceTransport, type DeviceTransportChannel } from "@/lib/devices/transport";

/** A channel that keeps what was sent and lets the test answer. */
function fakeChannel() {
  const sent: JsonRpcMessage[] = [];
  let deliver: ((message: JsonRpcMessage) => void) | null = null;
  let detached = false;

  const channel: DeviceTransportChannel = {
    publish: async (_deviceId, message) => {
      sent.push(message);
    },
    subscribe: async (_deviceId, listener) => {
      deliver = listener;
      return () => {
        detached = true;
      };
    },
  };

  return {
    channel,
    sent,
    deliver: (message: JsonRpcMessage) => deliver?.(message),
    get detached() {
      return detached;
    },
  };
}

const request: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
};

describe("DeviceTransport", () => {
  it("publishes what the MCP client sends onto the device's channel", async () => {
    const fake = fakeChannel();
    const transport = new DeviceTransport("dev-1", fake.channel);
    await transport.start();

    await transport.send(request);

    expect(fake.sent).toEqual([request]);
  });

  it("hands the device's answers to the MCP client", async () => {
    const fake = fakeChannel();
    const transport = new DeviceTransport("dev-1", fake.channel);
    const received: JsonRpcMessage[] = [];
    transport.onMessage((message) => received.push(message));
    await transport.start();

    const response: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    fake.deliver(response);

    expect(received).toEqual([response]);
  });

  it("stops listening and announces the close once", async () => {
    const fake = fakeChannel();
    const transport = new DeviceTransport("dev-1", fake.channel);
    const onClose = vi.fn();
    transport.onClose(onClose);
    await transport.start();

    await transport.close();
    await transport.close();

    expect(fake.detached).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses to send on a closed channel", async () => {
    const fake = fakeChannel();
    const transport = new DeviceTransport("dev-1", fake.channel);
    await transport.start();
    await transport.close();

    await expect(transport.send(request)).rejects.toThrow(/closed/);
  });

  it("reports a publish failure instead of swallowing it", async () => {
    const failing: DeviceTransportChannel = {
      publish: () => Promise.reject(new Error("redis is down")),
      subscribe: async () => () => {},
    };
    const transport = new DeviceTransport("dev-1", failing);
    const onError = vi.fn();
    transport.onError(onError);
    await transport.start();

    await expect(transport.send(request)).rejects.toThrow("redis is down");
    expect(onError).toHaveBeenCalledWith(new Error("redis is down"));
  });
});
