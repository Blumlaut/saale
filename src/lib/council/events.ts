/**
 * The room's live channel.
 *
 * A run is long, parallel and mostly invisible: members think, call tools and
 * post while the owner watches. The room streams over the chat's event bus
 * (`lib/pi/session-events`), keyed by the council id. it already provides
 * cross-process publish/subscribe, a monotonic event id and a replay buffer, and
 * its Redis keys are namespaced by that id, so a council's events cannot meet a
 * chat's. Reimplementing that for councils would be 150 lines of the same code.
 *
 * Publishing never throws: a lost event costs a repaint, and the room is
 * rebuilt from the database on reconnect regardless.
 */

import { publishSessionEvent } from "@/lib/pi/session-events";
import type { RoomMessageView } from "./room";

/** Events the room's SSE stream carries. */
export type CouncilEventName =
  | "run_started"
  | "turn_started"
  | "thinking"
  | "tool_call"
  | "turn_ended"
  | "message"
  | "notice"
  | "run_ended";

export async function publishCouncilEvent(
  councilId: string,
  event: CouncilEventName,
  data: unknown,
): Promise<void> {
  await publishSessionEvent(councilId, event, data).catch((err) => {
    console.error(`Failed to publish council event "${event}" for ${councilId}:`, err);
  });
}

/** Announce a new room message, whoever posted it. */
export async function publishRoomMessage(
  councilId: string,
  message: RoomMessageView,
): Promise<void> {
  await publishCouncilEvent(councilId, "message", message);
}
