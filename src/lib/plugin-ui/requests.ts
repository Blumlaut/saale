/**
 * Plugin UI requests: a dialog a Pi extension opens in the chat.
 *
 * Pi hands an extension `ctx.ui`, which in a terminal is a TUI overlay. Here it
 * is a card in the chat, and the round trip is the one approvals already use:
 * the request is written to Redis (so any process can answer it), announced on
 * the session bus, and the extension's promise settles when a decision arrives
 * from any client, another process, or the deadline.
 *
 * Dialogs are blocking: the run waits for the answer, so everything here is
 * bounded. A request that nobody answers is cancelled at its deadline rather
 * than denied — the user never said no, they were not there.
 */

import { randomUUID } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { publishSessionEvent, subscribeSessionEvents } from "@/lib/pi/session-events";

/** How long a plugin dialog waits for an answer before it is cancelled. */
export const PLUGIN_UI_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many of a session's dialogs may be outstanding at once.
 *
 * A plugin in a loop could otherwise leave a queue of cards that outlives the
 * run which opened them, with the oldest one blocking the newest forever.
 */
export const PLUGIN_UI_MAX_PENDING = 3;

const KEY_PREFIX = "saale:plugin-ui:";

/** The dialog methods Pi offers an extension. */
export type PluginUiKind = "select" | "confirm" | "input" | "editor";

/** What a request is asking for, in the plugin's own words. */
export interface PluginUiRequest {
  id: string;
  sessionId: string;
  userId: string;
  kind: PluginUiKind;
  title: string;
  /** The body of a `confirm`, when the plugin supplied one. */
  message?: string | null;
  /** The choices a `select` offers. */
  options?: string[];
  placeholder?: string | null;
  /** The text an `editor` starts with. */
  prefill?: string | null;
  createdAt: number;
  expiresAt: number;
  /** Set once the dialog has been answered or dismissed. */
  response?: PluginUiResponse;
}

/** The answer, in the shape each dialog method returns. */
export interface PluginUiResponse {
  /** `select`, `input` and `editor`. */
  value?: string;
  /** `confirm`. */
  confirmed?: boolean;
  /** The dialog was dismissed, timed out, or the run was stopped. */
  cancelled?: boolean;
}

/** What a client renders, whether it arrives live or in the snapshot. */
export interface PluginUiPayload {
  id: string;
  kind: PluginUiKind;
  title: string;
  message: string | null;
  options: string[] | null;
  placeholder: string | null;
  prefill: string | null;
  expiresAt: string;
}

export function toPluginUiPayload(request: PluginUiRequest): PluginUiPayload {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    message: request.message ?? null,
    options: request.options ?? null,
    placeholder: request.placeholder ?? null,
    prefill: request.prefill ?? null,
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

const keyOf = (sessionId: string, id: string) => `${KEY_PREFIX}${sessionId}:${id}`;

/** Held by whoever is answering, for as long as recording the answer takes. */
const CLAIM_SUFFIX = ":claim";
const claimKeyOf = (sessionId: string, id: string) => `${keyOf(sessionId, id)}${CLAIM_SUFFIX}`;

async function releaseClaim(sessionId: string, id: string): Promise<void> {
  try {
    await getRedis().del(claimKeyOf(sessionId, id));
  } catch (err) {
    console.error("Failed to release the plugin UI claim in Redis:", err);
  }
}

async function store(request: PluginUiRequest): Promise<void> {
  const ttl = Math.ceil((request.expiresAt - Date.now()) / 1000);
  try {
    await getRedis().setex(
      keyOf(request.sessionId, request.id),
      Math.max(ttl, 1),
      JSON.stringify(request),
    );
  } catch (err) {
    console.error("Failed to store plugin UI request in Redis:", err);
  }
}

async function read(sessionId: string, id: string): Promise<PluginUiRequest | null> {
  try {
    const raw = await getRedis().get(keyOf(sessionId, id));
    return raw ? (JSON.parse(raw) as PluginUiRequest) : null;
  } catch (err) {
    console.error("Failed to read plugin UI request from Redis:", err);
    return null;
  }
}

/** Dialogs waiting for an answer in this session, oldest first. */
export async function getPendingPluginUiRequests(sessionId: string): Promise<PluginUiRequest[]> {
  return scan(`${KEY_PREFIX}${sessionId}:*`);
}

/**
 * The dialogs waiting on one user, in any of their chats.
 *
 * Reads the whole key prefix: a session id is not derivable from a user id, and
 * the alternative (an index per user) is a second thing to keep honest for a
 * handful of keys.
 */
export async function getPendingPluginUiRequestsForUser(
  userId: string,
): Promise<Array<{ sessionId: string; request: PluginUiRequest }>> {
  const requests = await scan(`${KEY_PREFIX}*`);
  return requests
    .filter((request) => request.userId === userId)
    .map((request) => ({ sessionId: request.sessionId, request }));
}

/** Every unanswered, unexpired request under one key pattern. */
async function scan(pattern: string): Promise<PluginUiRequest[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = "0";

  try {
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = next;
      keys.push(...batch.filter((key) => !key.endsWith(CLAIM_SUFFIX)));
    } while (cursor !== "0");
    if (keys.length === 0) return [];

    const values = await redis.mget(keys);
    return values
      .filter((value): value is string => value !== null)
      .map((value) => {
        try {
          return JSON.parse(value) as PluginUiRequest;
        } catch (err) {
          console.error("Malformed plugin UI request in Redis:", err);
          return null;
        }
      })
      .filter((request): request is PluginUiRequest => request !== null)
      .filter((request) => request.expiresAt > Date.now() && request.response === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.error("Failed to list pending plugin UI requests:", err);
    return [];
  }
}

/**
 * Answer a dialog. Idempotent: the first answer wins, and a second one (another
 * tab, a Telegram tap) reports that there was nothing left to answer.
 */
export async function resolvePluginUiRequest(
  sessionId: string,
  id: string,
  response: PluginUiResponse,
): Promise<boolean> {
  // Two surfaces can answer the same dialog in the same instant. The claim is
  // what makes one of them lose, rather than both writing their own answer.
  const claimed = await getRedis().set(claimKeyOf(sessionId, id), "1", "EX", 30, "NX");
  if (claimed !== "OK") return false;

  const request = await read(sessionId, id);
  if (!request || request.response) {
    await releaseClaim(sessionId, id);
    return false;
  }

  const resolved: PluginUiRequest = { ...request, response };
  const ttl = Math.ceil((request.expiresAt - Date.now()) / 1000);
  try {
    await getRedis().setex(keyOf(sessionId, id), Math.max(ttl, 30), JSON.stringify(resolved));
  } catch (err) {
    console.error("Failed to record the plugin UI answer in Redis:", err);
    await releaseClaim(sessionId, id);
  }

  await publishSessionEvent(sessionId, "plugin_ui_resolved", {
    sessionId,
    id,
    response,
  }).catch((err: unknown) => {
    console.error("Failed to publish the plugin UI answer:", err);
  });

  return true;
}

/** What a caller knows about the dialog it wants to open. */
export type PluginUiRequestInput = Omit<PluginUiRequest, "id" | "createdAt" | "expiresAt">;

/**
 * Open a dialog and wait for its answer.
 *
 * Resolves with `cancelled` when the deadline passes, the run is stopped, or
 * the session already has as many dialogs waiting as it may have.
 */
export async function requestPluginUi(
  request: PluginUiRequestInput,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    /** Other surfaces to announce the dialog on. Telegram, for one. */
    onOpen?: ((request: PluginUiRequest) => void) | undefined;
  } = {},
): Promise<PluginUiResponse> {
  const pending = await getPendingPluginUiRequests(request.sessionId);
  if (pending.length >= PLUGIN_UI_MAX_PENDING) {
    console.error(
      `Plugin UI: ${request.sessionId} already has ${pending.length} dialogs waiting, refusing "${request.title}".`,
    );
    return { cancelled: true };
  }

  const full: PluginUiRequest = {
    ...request,
    id: randomUUID(),
    createdAt: Date.now(),
    expiresAt: Date.now() + (options.timeoutMs ?? PLUGIN_UI_TIMEOUT_MS),
  };

  void store(full);
  await publishSessionEvent(request.sessionId, "plugin_ui_request", toPluginUiPayload(full)).catch(
    (err: unknown) => {
      console.error("Failed to publish plugin UI request:", err);
    },
  );

  try {
    options.onOpen?.(full);
  } catch (err) {
    console.error("Failed to announce a plugin UI request elsewhere:", err);
  }

  return wait(full, options.signal);
}

/** The wait itself: bus event, deadline, or abort. */
function wait(request: PluginUiRequest, signal?: AbortSignal): Promise<PluginUiResponse> {
  return new Promise<PluginUiResponse>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeBus: (() => void) | null = null;

    const finish = (response: PluginUiResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsubscribeBus) unsubscribeBus();
      signal?.removeEventListener("abort", onAbort);
      resolve(response);
    };

    const onAbort = () => {
      void resolvePluginUiRequest(request.sessionId, request.id, { cancelled: true }).catch(
        (err: unknown) => {
          console.error("Failed to cancel a plugin UI request:", err);
        },
      );
      finish({ cancelled: true });
    };

    timer = setTimeout(
      () => {
        void resolvePluginUiRequest(request.sessionId, request.id, { cancelled: true }).catch(
          (err: unknown) => {
            console.error("Failed to expire a plugin UI request:", err);
          },
        );
        finish({ cancelled: true });
      },
      Math.max(request.expiresAt - Date.now(), 0),
    );

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    subscribeSessionEvents(request.sessionId, (event) => {
      if (event.event !== "plugin_ui_resolved") return;
      const data = event.data as { id?: string; response?: PluginUiResponse };
      if (data.id !== request.id) return;
      finish(data.response ?? { cancelled: true });
    })
      .then((unsubscribe) => {
        if (settled) unsubscribe();
        else unsubscribeBus = unsubscribe;
      })
      .catch((err: unknown) => {
        console.error("Failed to subscribe to plugin UI answers:", err);
      });
  });
}
