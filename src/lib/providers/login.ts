/**
 * Pi's provider sign-in flows, driven from a browser.
 *
 * Pi already defines how every provider is authenticated: `provider.auth` holds
 * an api-key method and/or an OAuth method, and each one is an interactive
 * `login()` that asks for what it needs through an `AuthInteraction`. a prompt
 * for a value, a notification for the user. The Pi CLI renders that against its
 * terminal; Saale renders it against HTTP.
 *
 * Nothing here knows what any provider asks for. A flow runs detached, publishes
 * its prompt and its notifications into Redis, and waits there for the answer,
 * so a sign-in survives page reloads and works across Saale processes.
 *
 * Browser-based OAuth flows bind a loopback callback server on the *server*,
 * which a user's browser cannot reach. Pi handles exactly that case: every flow
 * either offers a headless method (device code, copy code) or falls back to
 * asking for the final redirect URL, and the flow's own instructions tell the
 * user which one they are in.
 */

import { createHmac, randomUUID } from "crypto";
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { getRedis } from "@/lib/redis";
import {
  createProviderCredentialStore,
  type ProviderScope,
} from "@/lib/providers/credential-store";

/** Which auth method of a provider to run. */
export type ProviderAuthType = "api_key" | "oauth";

/** How long a sign-in may stay unfinished before Redis drops it. */
const SESSION_TTL_SECONDS = 20 * 60;

/**
 * How often a waiting flow looks for an answer and for a cancellation.
 *
 * A sign-in waits on the user, so a fraction of a second of latency is
 * irrelevant. and polling keeps every Redis command non-blocking, which a
 * shared connection cannot afford (`BLPOP` would hold it for the whole wait).
 */
const WAIT_POLL_MS = 250;

/** Bounded event log. a flow emits a handful, but a bug must not grow the state. */
const MAX_LOGIN_EVENTS = 50;

/** Notification kinds Pi emits, as they cross the wire. */
export interface ProviderLoginEvent {
  kind: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  links?: { url: string; label?: string }[];
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSeconds?: number;
}

/** A question from the flow, to be answered by `answerProviderLogin`. */
export interface ProviderLoginPrompt {
  /** Identifies this question so a late answer cannot answer the next one. */
  seq: number;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface ProviderLoginState {
  id: string;
  providerId: string;
  authType: ProviderAuthType;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  events: ProviderLoginEvent[];
  prompt: ProviderLoginPrompt | null;
  error: string | null;
  updatedAt: string;
}

/** The state plus its owner, as stored in Redis. */
interface StoredLoginState extends ProviderLoginState {
  /** Owner of the sign-in; a user's flow is invisible to every other user. */
  owner: string;
}

function ownerOf(scope: ProviderScope): string {
  return scope.kind === "global" ? "global" : scope.userId;
}

function stateKey(id: string): string {
  return `provider-login:${id}`;
}

function answerKey(id: string): string {
  return `provider-login:${id}:answer`;
}

function cancelKey(id: string): string {
  return `provider-login:${id}:cancel`;
}

/** Strip the ownership field. it never leaves the server. */
function toPublicState(state: StoredLoginState): ProviderLoginState {
  const { owner: _owner, ...rest } = state;
  return rest;
}

function initialState(options: {
  id: string;
  scope: ProviderScope;
  providerId: string;
  authType: ProviderAuthType;
}): StoredLoginState {
  return {
    id: options.id,
    owner: ownerOf(options.scope),
    providerId: options.providerId,
    authType: options.authType,
    status: "pending",
    events: [],
    prompt: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A stable, per-scope installation id for providers that identify the client
 * "Sign in with ChatGPT" sends it as its agent host id.
 *
 * Pi derives one from its settings file; Saale has no such file, and the id must
 * survive restarts, so it is derived from the scope. Hashing with the app's
 * encryption key keeps the user id itself out of what the provider receives.
 */
function providerDeviceId(scope: ProviderScope): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("ENCRYPTION_KEY is required to derive a provider device id");
  }
  const digest = createHmac("sha256", secret).update(ownerOf(scope)).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(12, 15)}-a${digest.slice(15, 18)}-${digest.slice(18, 30)}`;
}

/** Pi's notification, in the shape the browser needs. */
function toLoginEvent(event: AuthEvent): ProviderLoginEvent {
  switch (event.type) {
    case "info":
      return {
        kind: "info",
        message: event.message,
        ...(event.links ? { links: event.links.map((link) => ({ ...link })) } : {}),
      };
    case "auth_url":
      return {
        kind: "auth_url",
        url: event.url,
        ...(event.instructions ? { instructions: event.instructions } : {}),
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
      };
    case "progress":
      return { kind: "progress", message: event.message };
  }
}

/** Pi's prompt, in the shape the browser needs. */
function toLoginPrompt(seq: number, prompt: AuthPrompt): ProviderLoginPrompt {
  // The select variant has no placeholder; the other three do.
  const placeholder = "placeholder" in prompt ? prompt.placeholder : undefined;
  return {
    seq,
    kind: prompt.type,
    message: prompt.message,
    ...(placeholder ? { placeholder } : {}),
    ...(prompt.type === "select"
      ? {
          options: prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        }
      : {}),
  };
}

/** The answer a browser left for the flow, or nothing when it has not yet. */
async function takeAnswer(id: string, seq: number): Promise<{ answered: boolean; value: string }> {
  const raw = await getRedis().lpop(answerKey(id));
  if (raw === null) return { answered: false, value: "" };

  let parsed: { seq: number; value: string };
  try {
    parsed = JSON.parse(raw) as { seq: number; value: string };
  } catch (err) {
    console.error(`Failed to parse an answer for sign-in ${id}:`, err);
    return { answered: false, value: "" };
  }

  // An answer to an earlier question must be dropped, not applied to this one.
  if (parsed.seq !== seq) return { answered: false, value: "" };
  return { answered: true, value: parsed.value };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one sign-in flow to completion, publishing what it asks for.
 *
 * The state lives in Redis so the browser can follow along; the answers come
 * back through `answerProviderLogin`. When the flow settles, Pi has already
 * stored the credential through Saale's credential store.
 */
async function runProviderLogin(options: {
  id: string;
  scope: ProviderScope;
  providerId: string;
  authType: ProviderAuthType;
}): Promise<void> {
  const { id, scope, providerId, authType } = options;
  const redis = getRedis();
  const controller = new AbortController();

  let state: StoredLoginState = initialState(options);

  /** State writes are chained so a notification cannot overtake a prompt. */
  let writes: Promise<unknown> = Promise.resolve();
  function persist(): Promise<void> {
    writes = writes
      .then(() =>
        redis
          .multi()
          .set(stateKey(id), JSON.stringify(state), "EX", SESSION_TTL_SECONDS)
          .expire(answerKey(id), SESSION_TTL_SECONDS)
          .expire(cancelKey(id), SESSION_TTL_SECONDS)
          .exec(),
      )
      .catch((err) => {
        console.error(`Failed to store the sign-in state for ${providerId}:`, err);
      });
    return writes.then(() => undefined);
  }

  async function isCancelled(): Promise<boolean> {
    return (await redis.get(cancelKey(id))) === "1";
  }

  let promptSeq = 0;

  const interaction: ProviderAuthInteraction = {
    signal: controller.signal,

    async prompt(prompt: AuthPrompt): Promise<string> {
      const seq = ++promptSeq;
      state = { ...state, prompt: toLoginPrompt(seq, prompt), updatedAt: new Date().toISOString() };
      await persist();

      while (true) {
        if (prompt.signal?.aborted) throw new Error("Login cancelled");

        const answer = await takeAnswer(id, seq);
        if (answer.answered) {
          state = { ...state, prompt: null, updatedAt: new Date().toISOString() };
          await persist();
          return answer.value;
        }

        if (await isCancelled()) throw new Error("Login cancelled");
        await delay(WAIT_POLL_MS);
      }
    },

    notify(event: AuthEvent): void {
      state = {
        ...state,
        events: [...state.events, toLoginEvent(event)].slice(-MAX_LOGIN_EVENTS),
        updatedAt: new Date().toISOString(),
      };
      void persist();
    },
  };

  /**
   * Cancellation must reach a flow waiting on the network too. a device-code
   * poll or a token exchange never reaches `prompt()` again.
   */
  const cancelWatch = setInterval(() => {
    void isCancelled()
      .then((cancelled) => {
        if (cancelled) controller.abort();
      })
      .catch((err) => {
        console.error(`Failed to check the cancellation of the ${providerId} sign-in:`, err);
      });
  }, WAIT_POLL_MS);

  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: createProviderCredentialStore(scope),
      modelsPath: null,
    });

    // Pi persists the credential through Saale's store before this resolves.
    await modelRuntime.login(providerId, authType, interaction, {
      getDeviceId: () => providerDeviceId(scope),
    });

    state = {
      ...state,
      status: "succeeded",
      prompt: null,
      // Never the credential itself. the browser only needs to know it worked.
      events: [...state.events, { kind: "progress" as const, message: "Signed in." }].slice(
        -MAX_LOGIN_EVENTS,
      ),
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const cancelled = await isCancelled().catch(() => false);
    const message = err instanceof Error ? err.message : String(err);
    state = {
      ...state,
      status: cancelled ? "cancelled" : "failed",
      prompt: null,
      error: cancelled ? null : message,
      updatedAt: new Date().toISOString(),
    };
    if (!cancelled) {
      console.error(`Sign-in to ${providerId} failed:`, err);
    }
  } finally {
    clearInterval(cancelWatch);
    await persist();
    await redis.del(answerKey(id), cancelKey(id));
  }
}

/**
 * Start a sign-in and return its id.
 *
 * The flow runs detached: the caller polls `readProviderLogin` for what it asks
 * next. A flow that fails before it asks anything still reports why, so the id
 * is always worth polling.
 */
export async function startProviderLogin(options: {
  scope: ProviderScope;
  providerId: string;
  authType: ProviderAuthType;
}): Promise<string> {
  const id = randomUUID();
  const state = initialState({ ...options, id });

  // Claim the keys before the flow starts, so a poll arriving first sees a
  // pending sign-in rather than a missing one.
  await getRedis()
    .multi()
    .set(stateKey(id), JSON.stringify(state), "EX", SESSION_TTL_SECONDS)
    .set(cancelKey(id), "0", "EX", SESSION_TTL_SECONDS)
    .exec();

  void runProviderLogin({ ...options, id }).catch((err) => {
    console.error(`Provider sign-in for ${options.providerId} crashed:`, err);
  });

  return id;
}

/** Read a sign-in's state, if the caller owns it and it has not expired. */
export async function readProviderLogin(
  scope: ProviderScope,
  id: string,
): Promise<ProviderLoginState | undefined> {
  const raw = await getRedis().get(stateKey(id));
  if (!raw) return undefined;

  let state: StoredLoginState;
  try {
    state = JSON.parse(raw) as StoredLoginState;
  } catch (err) {
    console.error(`Failed to parse the sign-in state ${id}:`, err);
    return undefined;
  }

  if (state.owner !== ownerOf(scope)) return undefined;
  return toPublicState(state);
}

/** Answer the prompt a sign-in is currently waiting on. */
export async function answerProviderLogin(
  scope: ProviderScope,
  id: string,
  seq: number,
  value: string,
): Promise<ProviderLoginState | undefined> {
  const state = await readProviderLogin(scope, id);
  if (!state) return undefined;
  if (state.prompt?.seq !== seq) {
    throw new Error("That sign-in step is no longer waiting for an answer");
  }

  await getRedis().rpush(answerKey(id), JSON.stringify({ seq, value }));
  return readProviderLogin(scope, id);
}

/** Cancel a running sign-in; the flow stops at its next check. */
export async function cancelProviderLogin(scope: ProviderScope, id: string): Promise<void> {
  const state = await readProviderLogin(scope, id);
  if (!state || state.status !== "pending") return;
  await getRedis().set(cancelKey(id), "1", "EX", SESSION_TTL_SECONDS);
}
