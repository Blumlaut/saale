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
