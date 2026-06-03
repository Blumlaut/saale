import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";

/**
 * Require an admin session. Returns a 403 NextResponse if not admin.
 */
export async function requireAdmin(): Promise<
  { ok: true; user: { id: string } } | { ok: false; response: NextResponse }
> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const userRole = (session.user as Record<string, unknown>).role as string | null | undefined;
  if (userRole !== "admin") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, user: { id: session.user.id } };
}
