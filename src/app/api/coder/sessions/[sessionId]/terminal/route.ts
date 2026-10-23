import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  MAX_TERMINAL_COMMAND_LENGTH,
  runTerminalCommand,
  resolveTerminalTarget,
  TerminalNotReadyError,
} from "@/lib/coder/terminal";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { formatSseEvent } from "@/lib/pi/stream-logic";

/**
 * POST /api/coder/sessions/:id/terminal. run one command in the chat's worktree.
 *
 * Server-sent events because output arrives for as long as the command runs: a
 * dev server prints indefinitely, so there is no answer to wait for. Closing the
 * connection stops the command, which is what a person means by leaving the
 * panel.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Quiet enough for a long build, busy enough that a proxy keeps the pipe. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

const commandSchema = z.object({
  // Only the command: the directory is the chat's worktree, resolved here.
  command: z.string().min(1).max(MAX_TERMINAL_COMMAND_LENGTH),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { sessionId } = await params;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable terminal request body:", err);
    return null;
  });
  const parsed = commandSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Expected { command } up to ${MAX_TERMINAL_COMMAND_LENGTH} characters` },
      { status: 400 },
    );
  }

  let target;
  try {
    target = await resolveTerminalTarget(userId, sessionId);
  } catch (err) {
    if (err instanceof TerminalNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(`Failed to resolve the terminal for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not open the worktree" }, { status: 500 });
  }
  if (!target) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const command = parsed.data.command;
  const encoder = new TextEncoder();
  const abort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);
      const send = (event: string, payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
        } catch (err) {
          // The client left; the abort below is what ends the command.
          console.warn(`Terminal stream for chat ${sessionId} closed early:`, err);
        }
      };

      try {
        for await (const event of runTerminalCommand({
          userId,
          sessionId,
          target,
          command,
          signal: abort.signal,
        })) {
          send(event.type, event);
        }
      } catch (err) {
        console.error(`Terminal command failed in chat ${sessionId}:`, err);
        send("error", { message: err instanceof Error ? err.message : "Terminal failed" });
      } finally {
        heartbeat.stop();
        try {
          controller.close();
        } catch (err) {
          console.warn(`Terminal stream for chat ${sessionId} was already closed:`, err);
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
