/**
 * What the agent asked a paired computer to do.
 *
 * Written by the approval gate, which is the one place every device tool call
 * passes through: a call the user refused is recorded too, so the page answers
 * "what has this machine been asked" and not only "what did it run".
 *
 * A write that fails must not fail the call it is recording, so it is logged
 * and dropped.
 */

import { prisma } from "@/lib/db";

export type DeviceCallOutcome = "ok" | "error" | "blocked";

export interface DeviceCallEntry {
  summary: string;
  outcome: DeviceCallOutcome;
  /** The tool as the agent offers it, e.g. `click`. */
  tool: string;
  createdAt: string;
}

/** Record one call. */
export async function recordDeviceCall(entry: {
  deviceId: string;
  userId: string;
  sessionId: string;
  tool: string;
  summary: string;
  outcome: DeviceCallOutcome;
}): Promise<void> {
  try {
    await prisma.deviceCall.create({
      data: {
        deviceId: entry.deviceId,
        userId: entry.userId,
        sessionId: entry.sessionId,
        tool: entry.tool.slice(0, 64),
        summary: entry.summary,
        outcome: entry.outcome,
      },
    });
  } catch (err) {
    console.error(`Failed to record a device call on ${entry.deviceId}:`, err);
  }
}

/** The most recent calls of a set of devices, newest first, keyed by device. */
export async function recentDeviceCalls(
  userId: string,
  deviceIds: string[],
  perDevice = 3,
): Promise<Map<string, DeviceCallEntry[]>> {
  const byDevice = new Map<string, DeviceCallEntry[]>();
  if (deviceIds.length === 0) return byDevice;

  const rows = await prisma.deviceCall.findMany({
    where: { userId, deviceId: { in: deviceIds } },
    orderBy: { createdAt: "desc" },
    select: { deviceId: true, tool: true, summary: true, outcome: true, createdAt: true },
  });

  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    if (list.length >= perDevice) continue;
    list.push({
      tool: row.tool,
      summary: row.summary,
      outcome: row.outcome === "blocked" || row.outcome === "error" ? row.outcome : "ok",
      createdAt: row.createdAt.toISOString(),
    });
    byDevice.set(row.deviceId, list);
  }

  return byDevice;
}
