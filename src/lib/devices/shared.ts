/**
 * Rules shared by the devices API, the settings UI and the Pi wiring.
 *
 * Kept free of server-only imports (database, crypto, Pi) so client components
 * can render a device without pulling a server module into the browser bundle.
 */

/**
 * The tool groups a desktop agent can offer.
 *
 * The agent owns the switches: a group it turned off contributes no tool at
 * all, so the model cannot see it, call it or discover it in codemode.
 */
export const DEVICE_GROUPS = ["screen", "mouse", "keyboard", "files", "terminal"] as const;
export type DeviceGroup = (typeof DEVICE_GROUPS)[number];

export const DEVICE_GROUP_LABELS: Record<DeviceGroup, string> = {
  screen: "Screen",
  mouse: "Mouse",
  keyboard: "Keyboard",
  files: "Files",
  terminal: "Terminal",
};

export function isDeviceGroup(value: unknown): value is DeviceGroup {
  return typeof value === "string" && (DEVICE_GROUPS as readonly string[]).includes(value);
}

/** Fold what an agent reports into the groups Saale knows, dropping anything else. */
export function readDeviceGroups(value: unknown): DeviceGroup[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isDeviceGroup))];
}

/** Longest device label the settings page renders and Pi accepts in a server name. */
const DEVICE_NAME_MAX = 64;

/**
 * A label for a machine, safe to use as an MCP server name.
 *
 * A device contributes tools as `mcp__<name>__<tool>`, so the label has to be
 * the same character set a server name is.
 */
export function sanitizeDeviceName(input: string, fallback = "computer"): string {
  const folded = input
    .trim()
    .toLowerCase()
    // A dot is legal in a hostname and not in a tool name.
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return (folded.slice(0, DEVICE_NAME_MAX).replace(/[-_]+$/, "") || fallback).trim();
}

/**
 * Cookie the desktop agent's window sets on this origin, holding its device id.
 *
 * A chat started from that window remembers it and may then reach that machine.
 * The value is checked against the user's own devices when it is used, so a
 * forged cookie cannot widen what an agent reaches beyond the user's machines.
 */
export const CLIENT_DEVICE_COOKIE = "saale_client";

/**
 * The URL a device entry carries.
 *
 * Pi's MCP config needs one and never fetches it: the transport factory in
 * `lib/mcp/servers.ts` builds a `DeviceTransport` for this scheme instead of an
 * HTTP transport.
 */
export function deviceUrl(deviceId: string): string {
  return `device://${deviceId}`;
}

/** The device id inside a `device://` URL, or null when it is not one. */
export function deviceIdFromUrl(url: string): string | null {
  if (!url.startsWith("device://")) return null;
  const id = url.slice("device://".length);
  return id.length > 0 ? id : null;
}
