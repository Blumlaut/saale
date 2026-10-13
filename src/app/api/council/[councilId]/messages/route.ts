import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { councilMessageSchema } from "@/lib/council/schema";
import { CouncilBusyError, startCouncilRun } from "@/lib/council/run";
import { getCouncil, listRoomMessages } from "@/lib/council/store";
import { postRoomMessage, loadOwnerName } from "@/lib/council/persist";
import { publishRoomMessage } from "@/lib/council/events";
import {
  ALL_HANDLE,
  USER_HANDLE,
  addressesEveryone,
  mentionHelp,
  resolveMentions,
} from "@/lib/council/mentions";
import { MAX_ROOM_PAGE } from "@/lib/council/config";

/**
 * POST /api/council/[councilId]/messages — the owner speaks into the room.
 *
 * The message is stored first and a run started second, because those are two
 * separate truths: the message is in the room whatever happens next, and a run
 * that cannot start (the council is already working, the sandbox is down) must
 * not lose what the owner said.
 *
 * A message posted while a run is in flight is picked up by that run — the loop
 * absorbs room messages it did not post itself and wakes whoever they address,
 * so speaking mid-run steers the room rather than waiting for it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, councilMessageSchema);
  if (!body.ok) return body.response;

  try {
    const council = await getCouncil(caller.userId, councilId);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const enabled = council.members
      .filter((member) => member.enabled)
      .map((member) => ({ id: member.id, name: member.name }));

    const resolution = resolveMentions(body.data.content, enabled);
    if (resolution.unknown.length > 0) {
      // Refused rather than posted: the owner meant to reach someone.
      return NextResponse.json(
        {
          error: `Unknown member${resolution.unknown.length === 1 ? "" : "s"} ${resolution.unknown
            .map((handle) => `@${handle}`)
            .join(", ")}. The members are: ${mentionHelp(enabled)}`,
        },
        { status: 400 },
      );
    }

    const addressedNames = enabled
      .filter((member) => resolution.memberIds.includes(member.id))
      .map((member) => member.name);
    const mentions = [
      ...(addressesEveryone(body.data.content) ? [ALL_HANDLE] : []),
      ...addressedNames,
      ...(resolution.addressesUser ? [USER_HANDLE] : []),
    ];

    const ownerName = await loadOwnerName(caller.userId);
    const message = await postRoomMessage({
      councilId,
      userId: caller.userId,
      runId: null,
      authorKind: "user",
      authorName: ownerName,
      content: body.data.content,
      mentions,
    });
    await publishRoomMessage(councilId, message);

    if (!body.data.startRun) {
      return NextResponse.json({ message, runStarted: false, running: false }, { status: 201 });
    }

    try {
      const run = await startCouncilRun({
        councilId,
        userId: caller.userId,
        openingMemberIds: addressedNames.length > 0 ? resolution.memberIds : null,
        triggerMessageId: message.id,
      });
      return NextResponse.json(
        { message, runStarted: true, running: true, runId: run.runId },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof CouncilBusyError) {
        // The room is already working: the message joins it rather than
        // starting a second run.
        return NextResponse.json(
          { message, runStarted: false, running: true, note: "The council is already running." },
          { status: 201 },
        );
      }
      throw err;
    }
  } catch (err) {
    return councilErrorResponse(err, `POST /api/council/${councilId}/messages`);
  }
}

/** GET /api/council/[councilId]/messages — the room, oldest first. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const { searchParams } = new URL(request.url);
  const sinceRaw = searchParams.get("sinceSeq");
  const sinceSeq = sinceRaw === null ? undefined : Number.parseInt(sinceRaw, 10);
  if (sinceSeq !== undefined && !Number.isFinite(sinceSeq)) {
    return NextResponse.json({ error: "sinceSeq must be a number" }, { status: 400 });
  }
  const limit = Math.min(
    MAX_ROOM_PAGE,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10) || 100),
  );

  try {
    const council = await getCouncil(caller.userId, councilId);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const messages = await listRoomMessages(caller.userId, councilId, {
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      limit,
    });
    return NextResponse.json({
      messages,
      lastSeq: messages.at(-1)?.seq ?? council.lastSeq,
    });
  } catch (err) {
    return councilErrorResponse(err, `GET /api/council/${councilId}/messages`);
  }
}
