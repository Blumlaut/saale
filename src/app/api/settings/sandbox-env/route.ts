import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  deleteSandboxEnvVar,
  listSandboxEnvNames,
  SandboxEnvError,
  setSandboxEnvVar,
} from "@/lib/sandbox/env";

/**
 * The user's sandbox variables.
 *
 * A read returns names. Values go in and never come back out: a settings page
 * that can display a token is a page that hands it to anyone with the session,
 * and a value in a response is a value in a log or a transcript.
 */

const setBodySchema = z.object({
  name: z.string().min(1).max(64),
  value: z.string().min(1),
});

/** GET /api/settings/sandbox-env: the names this user has set. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const names = await listSandboxEnvNames(authResult.user.id);
  return NextResponse.json({ names });
}

/** PUT /api/settings/sandbox-env: set one variable. */
export async function PUT(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch(() => null);
  const parsed = setBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { name, value }" }, { status: 400 });
  }

  try {
    await setSandboxEnvVar(authResult.user.id, parsed.data.name, parsed.data.value);
  } catch (err) {
    if (err instanceof SandboxEnvError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({ names: await listSandboxEnvNames(authResult.user.id) });
}

/** DELETE /api/settings/sandbox-env?name=GH_TOKEN: remove one variable. */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "Missing 'name' query parameter" }, { status: 400 });
  }

  try {
    const removed = await deleteSandboxEnvVar(authResult.user.id, name);
    if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    if (err instanceof SandboxEnvError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({ names: await listSandboxEnvNames(authResult.user.id) });
}
