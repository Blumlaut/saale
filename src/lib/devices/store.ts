/**
 * Device rows, as the settings page and the agent sessions read them.
 *
 * Every query carries the owner. A device id is guessable enough to be worth
 * asking for, and the tools behind it reach a real machine.
 */

import { prisma } from "@/lib/db";
import { recentDeviceCalls, type DeviceCallEntry } from "./audit";
import { isDeviceConnected } from "./channel";
import { readDeviceGroups, type DeviceGroup } from "./shared";

/** One connected computer, as the settings page lists it. */
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  session: string;
  capabilities: DeviceGroup[];
  agentVersion: string;
  /** Whether the agent holds a channel to this instance right now. */
  connected: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** The last few things this machine was asked to do. */
  recent: DeviceCallEntry[];
}

const DEVICE_FIELDS = {
  id: true,
  name: true,
  platform: true,
  session: true,
  capabilities: true,
  agentVersion: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

function toView(row: {
  id: string;
  name: string;
  platform: string;
  session: string;
  capabilities: string[];
  agentVersion: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}): Omit<DeviceView, "connected" | "recent"> {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    session: row.session,
    capabilities: readDeviceGroups(row.capabilities),
    agentVersion: row.agentVersion,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A user's devices, connected ones first. */
export async function listDevices(userId: string): Promise<DeviceView[]> {
  const rows = await prisma.device.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: DEVICE_FIELDS,
  });

  const calls = await recentDeviceCalls(
    userId,
    rows.map((row) => row.id),
  );

  const views = await Promise.all(
    rows.map(async (row) => ({
      ...toView(row),
      connected: await isDeviceConnected(row.id),
      recent: calls.get(row.id) ?? [],
    })),
  );

  return views.sort((a, b) => Number(b.connected) - Number(a.connected));
}

/**
 * The device a chat is allowed to reach, or null.
 *
 * Scoped to the owner: a chat carries the device id of the client that started
 * it, and a forged one must not widen what the agent can touch.
 */
export async function getChatDevice(
  userId: string,
  deviceId: string,
): Promise<{ id: string; name: string; capabilities: DeviceGroup[] } | null> {
  const row = await prisma.device.findFirst({
    where: { id: deviceId, userId, revokedAt: null },
    select: { id: true, name: true, capabilities: true },
  });
  if (!row) return null;
  return { id: row.id, name: row.name, capabilities: readDeviceGroups(row.capabilities) };
}

/** Disconnect a device. Its token stops working immediately. */
export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const { count } = await prisma.device.updateMany({
    where: { id: deviceId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

/** Record what an agent reports on connect: its tool groups and its version. */
export async function recordDeviceConnect(
  deviceId: string,
  info: {
    capabilities?: unknown;
    agentVersion?: string | undefined;
    session?: string | undefined;
    platform?: string | undefined;
  },
): Promise<void> {
  await prisma.device
    .update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        ...(info.capabilities === undefined
          ? {}
          : { capabilities: readDeviceGroups(info.capabilities) }),
        ...(info.agentVersion ? { agentVersion: info.agentVersion.slice(0, 40) } : {}),
        ...(info.session ? { session: info.session.slice(0, 16) } : {}),
        ...(info.platform ? { platform: info.platform.slice(0, 16) } : {}),
      },
    })
    .catch((err) => {
      console.error(`Failed to record the connect of device ${deviceId}:`, err);
    });
}
