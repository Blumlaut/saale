/**
 * The MCP server entry a chat gets for its own computer.
 *
 * A chat may reach the machine it was started from and no other. The device id
 * travels on the chat row (`ChatSession.clientDeviceId`), set from the client
 * that created it, and it is looked up here scoped to the user. A chat with no
 * device — one started from Telegram, from a phone, or from a plain browser —
 * gets no computer at all.
 */

import type { McpServerEntry } from "@earendil-works/pi-coding-agent";
import { mcpNameKey, type McpToolPolicy } from "@/lib/mcp/shared";
import { DEVICE_GROUP_LABELS, deviceUrl, sanitizeDeviceName } from "./shared";
import { getChatDevice } from "./store";

export interface DeviceMcpServers {
  entries: McpServerEntry[];
  policies: Record<string, McpToolPolicy>;
  /** The machine behind the entry, for the gate that revokes it mid-run. */
  device: { id: string; name: string } | null;
}

const NO_DEVICE: DeviceMcpServers = { entries: [], policies: {}, device: null };

/** The device entry for one chat, or nothing. */
export async function loadDeviceMcpServers(
  userId: string,
  clientDeviceId: string | null | undefined,
): Promise<DeviceMcpServers> {
  if (!clientDeviceId) return NO_DEVICE;

  const device = await getChatDevice(userId, clientDeviceId);
  if (!device) return NO_DEVICE;

  const name = sanitizeDeviceName(device.name);
  const groups = device.capabilities.map((group) => DEVICE_GROUP_LABELS[group].toLowerCase());

  const entry: McpServerEntry = {
    name,
    config: {
      type: "http",
      url: deviceUrl(device.id),
      // Declared to the model, so a screenshot or a click is its own tool call
      // with its own approval card.
      exposure: "direct",
      description:
        groups.length > 0
          ? `The computer this chat was started from. It offers ${groups.join(", ")}.`
          : "The computer this chat was started from.",
    },
    source: "Saale devices",
    scope: "extension",
  };

  return {
    entries: [entry],
    policies: { [mcpNameKey(name)]: "ask" },
    device: { id: device.id, name },
  };
}
