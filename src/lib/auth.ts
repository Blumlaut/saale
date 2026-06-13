import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * Sanitize error messages for API responses.
 * Prevents leaking internal details (DB errors, stack traces, etc.) to clients.
 */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    // Strip potential sensitive details (connection strings, file paths, SQL)
    return (
      msg
        .replace(/connection string.*$/i, "connection error")
        .replace(/\/home\/[^"]+/g, "/internal")
        .replace(/\/root\/[^"]+/g, "/internal")
        .replace(/at [^(]+\([^)]+\)/g, "")
        .trim()
        .slice(0, 200) || "An internal error occurred"
    );
  }
  return "An internal error occurred";
}

/**
 * Get the current session from API route context.
 * Returns null if not authenticated (caller should handle 401).
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/**
 * Require an authenticated session. Returns a 401 NextResponse if not authenticated.
 */
export async function requireSession(): Promise<
  { ok: true; user: { id: string; email?: string } } | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, user: session.user };
}

/**
 * Require an email account owned by the current user.
 * Returns the account if found, or a 401/404 NextResponse.
 */
export async function requireAccountOwner(
  accountId: string,
): Promise<
  | { ok: true; account: NonNullable<Awaited<ReturnType<typeof prisma.emailAccount.findFirst>>> }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, userId: authResult.user.id },
  });

  if (!account) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, account };
}

/**
 * Require a calendar account owned by the current user.
 * Returns the account if found, or a 401/404 NextResponse.
 */
export async function requireCalendarAccountOwner(
  accountId: string,
): Promise<
  | { ok: true; account: NonNullable<Awaited<ReturnType<typeof prisma.calendarAccount.findFirst>>> }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const account = await prisma.calendarAccount.findFirst({
    where: { id: accountId, userId: authResult.user.id },
  });

  if (!account) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, account };
}

/**
 * Require a chat session owned by the current user.
 * Returns the session if found, or a 401/404 NextResponse.
 */
export async function requireChatSessionOwner(sessionId: string): Promise<
  | {
      ok: true;
      session: NonNullable<Awaited<ReturnType<typeof prisma.chatSession.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, session, userId: authResult.user.id };
}

/**
 * Require a memory owned by the current user.
 * Returns the memory if found, or a 401/404 NextResponse.
 */
export async function requireMemoryOwner(memoryId: string): Promise<
  | {
      ok: true;
      memory: NonNullable<Awaited<ReturnType<typeof prisma.memory.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const memory = await prisma.memory.findFirst({
    where: { id: memoryId, userId: authResult.user.id },
  });

  if (!memory) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Memory not found" }, { status: 404 }),
    };
  }

  return { ok: true, memory, userId: authResult.user.id };
}

/**
 * Require a calendar event owned by the current user (via calendar -> account).
 * Returns the event if found, or a 401/404 NextResponse.
 * Uses nested where clause for ownership check; callers should include relations via separate queries if needed.
 */
export async function requireCalendarEventOwner(eventId: string): Promise<
  | {
      ok: true;
      event: NonNullable<Awaited<ReturnType<typeof prisma.calendarEvent.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const event = await prisma.calendarEvent.findFirst({
    where: {
      id: eventId,
      calendar: { account: { userId: authResult.user.id } },
    },
  });

  if (!event) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, event, userId: authResult.user.id };
}

/**
 * Require a calendar owned by the current user (via account).
 * Returns the calendar if found, or a 401/404 NextResponse.
 */
export async function requireCalendarOwner(calendarId: string): Promise<
  | {
      ok: true;
      calendar: NonNullable<Awaited<ReturnType<typeof prisma.calendar.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const calendar = await prisma.calendar.findFirst({
    where: {
      id: calendarId,
      account: { userId: authResult.user.id },
    },
  });

  if (!calendar) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, calendar, userId: authResult.user.id };
}

/**
 * Require a calendar subscription owned by the current user.
 * Returns the subscription if found, or a 401/404 NextResponse.
 */
export async function requireCalendarSubscriptionOwner(subscriptionId: string): Promise<
  | {
      ok: true;
      subscription: NonNullable<Awaited<ReturnType<typeof prisma.calendarSubscription.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const subscription = await prisma.calendarSubscription.findFirst({
    where: { id: subscriptionId, userId: authResult.user.id },
  });

  if (!subscription) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, subscription, userId: authResult.user.id };
}

/**
 * Require a queue task (job) owned by the current user.
 * Returns the task if found, or a 401/404 NextResponse.
 */
export async function requireJobOwner(jobId: string): Promise<
  | {
      ok: true;
      job: NonNullable<Awaited<ReturnType<typeof prisma.queueTask.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: authResult.user.id },
  });

  if (!job) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, job, userId: authResult.user.id };
}

/**
 * Require an email message owned by the current user (via account).
 * Returns the message if found, or a 401/404 NextResponse.
 */
export async function requireEmailMessageOwner(messageId: string): Promise<
  | {
      ok: true;
      message: NonNullable<Awaited<ReturnType<typeof prisma.emailMessage.findFirst>>>;
      userId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult;

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: authResult.user.id },
    },
  });

  if (!message) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true, message, userId: authResult.user.id };
}
