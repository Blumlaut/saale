/**
 * HTTP surface of Pi's provider sign-in flows, shared by the user and admin
 * routes — the only difference between them is which credential scope they
 * write to, and who may call them.
 *
 * The browser starts a sign-in, then polls it: the flow asks for one thing at a
 * time, and each answer is a separate request. Nothing is buffered in the
 * request handler, so a sign-in survives a reload, a second tab, or a different
 * Saale process serving the next request.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import type { ProviderScope } from "@/lib/providers/credential-store";
import {
  answerProviderLogin,
  cancelProviderLogin,
  readProviderLogin,
  startProviderLogin,
} from "@/lib/providers/login";

const startBodySchema = z.object({
  provider: z.string().min(1),
  authType: z.enum(["api_key", "oauth"]),
});

const answerBodySchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  value: z.string(),
});

/** POST — start a sign-in, returning the id to poll. */
export async function startLoginResponse(
  scope: ProviderScope,
  request: Request,
): Promise<NextResponse> {
  const body = startBodySchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json(
      { error: "A provider and an auth type (api_key or oauth) are required" },
      { status: 400 },
    );
  }

  try {
    const id = await startProviderLogin({
      scope,
      providerId: body.data.provider,
      authType: body.data.authType,
    });
    return NextResponse.json({ id, state: await readProviderLogin(scope, id) });
  } catch (err) {
    console.error(`Failed to start a sign-in to ${body.data.provider}:`, err);
    return NextResponse.json({ error: "Failed to start the sign-in" }, { status: 500 });
  }
}

/** GET — the state of a running sign-in. */
export async function loginStateResponse(
  scope: ProviderScope,
  request: Request,
): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const state = await readProviderLogin(scope, id);
  if (!state) {
    // Expired, finished and swept, or never this caller's.
    return NextResponse.json({ error: "This sign-in is no longer running" }, { status: 404 });
  }

  return NextResponse.json({ state });
}

/** POST — answer the step the flow is waiting on. */
export async function answerLoginResponse(
  scope: ProviderScope,
  request: Request,
): Promise<NextResponse> {
  const body = answerBodySchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: "id, seq and value are required" }, { status: 400 });
  }

  try {
    const state = await answerProviderLogin(scope, body.data.id, body.data.seq, body.data.value);
    if (!state) {
      return NextResponse.json({ error: "This sign-in is no longer running" }, { status: 404 });
    }
    return NextResponse.json({ state });
  } catch (err) {
    // The flow has moved past the step that was answered — a stale tab, most
    // likely. The caller polls the current state instead of retrying.
    const message = err instanceof Error ? err.message : "Failed to answer the sign-in";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

/** DELETE — cancel a running sign-in. */
export async function cancelLoginResponse(
  scope: ProviderScope,
  request: Request,
): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    await cancelProviderLogin(scope, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`Failed to cancel the sign-in ${id}:`, err);
    return NextResponse.json({ error: "Failed to cancel the sign-in" }, { status: 500 });
  }
}
