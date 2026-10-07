import { getRedis } from "@/lib/redis";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isApprovalScopeGranted } from "./approval-scope";
import { isAutoApproveActive } from "./auto-approve";
import { classifyCommand } from "./command-classifier";
import { publishSessionEvent, subscribeSessionEvents } from "./session-events";
import type { ToolPolicy } from "./tool-infos";
import { resolveToolPolicy } from "./tool-policy";
import { resolveApprovalSummary } from "./tool-approval-summary";
import { TOOL_ABORT_MESSAGE } from "./tool-abort";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Tools that support command-aware "auto" approval. */
const COMMAND_AWARE_TOOLS = new Set(["infra_exec", "bash"]);

/** How long an approval request waits before auto-denying (ms). */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Redis key prefix for pending approvals. */
const APPROVAL_KEY_PREFIX = "saale:approval:";

/**
 * Minimum TTL (s) kept on a resolved key. Keeps late resolution attempts
 * ("already resolved") distinguishable from "never existed" for a while.
 */
const RESOLVED_KEY_MIN_TTL_S = 30;

/**
 * Pending approval promises: toolCallId → { resolve, timer }.
 *
 * Process-local fast path only — cross-process delivery happens through the
 * session event bus (see waitForApproval), so an approval requested by an
 * agent in process A can be resolved by the API route in process B and the
 * wait in A still completes.
 */
interface PendingEntry {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How an approval request ended.
 *
 * `aborted` is kept apart from `denied`: the run was stopped while the user was
 * still deciding, so nothing was denied — recording a denial would blame the
 * user for a decision they never made, and the tool result would tell the model
 * the call was rejected when the whole run is over.
 */
export type ApprovalOutcome = "approved" | "denied" | "aborted";
const pendingApprovals = new Map<string, PendingEntry>();

/**
 * Request data stored in Redis for persistence across processes/restarts.
 *
 * The key doubles as the decision record: once `approved` and `resolvedAt`
 * are set, the request is resolved (in any process) and will not be
 * re-resolved. The value is written before the request is announced to
 * clients, so Redis is always the source of truth.
 */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  userId: string;
  args: Record<string, unknown>;
  /**
   * One-line "what is this call about" (ID-only references resolved against
   * the user's own records). Optional: records written before this field
   * existed have none, and the client re-derives one from the arguments.
   */
  summary?: string | null;
  /** Set when this one decision covers more than the call in front of it. */
  batch?: ApprovalBatch;
  createdAt: number;
  expiresAt: number;
  /** Present once the request has been decided (approved or denied). */
  approved?: boolean;
  /** Set instead of `approved` when the run ended before a decision. */
  cancelled?: boolean;
  resolvedAt?: number;
}

/**
 * The calls one decision stands in for.
 *
 * A script announces the calls it is about to make, and the user approves them
 * with the script — see `codemode-approval.ts`. Only the calls it *covers* run
 * on that approval: a call to a tool that is not listed still asks on its own,
 * and `dynamic` says the list may not be the script's whole plan, so the card
 * never reads as a blanket approval.
 */
export interface ApprovalBatch {
  /** Tool names the approval covers. */
  tools: string[];
  /** The tool can reach names its source does not show. */
  dynamic?: boolean;
}

/**
 * The client payload for an approval request — the same shape whether it arrives
 * as a live `tool_approval_request` event or in the reconnect snapshot, so the
 * two cannot drift.
 */
export interface ApprovalPayload {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string | null;
  batch?: ApprovalBatch;
  expiresAt: string;
}

/** Build the payload every approval channel and the reconnect snapshot send. */
export function toApprovalPayload(request: ApprovalRequest): ApprovalPayload {
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    args: request.args,
    summary: request.summary ?? null,
    ...(request.batch ? { batch: request.batch } : {}),
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

/** Payload of the `tool_approval_resolved` session bus event. */
export interface ApprovalResolutionData {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  approved: boolean;
  /** The run ended before a decision — the card is gone, nothing was denied. */
  cancelled?: boolean;
  expiresAt: string;
}

const approvalKey = (sessionId: string, toolCallId: string) =>
  `${APPROVAL_KEY_PREFIX}${sessionId}:${toolCallId}`;

// ─── Redis persistence ───────────────────────────────────────────────────────

/** Write the approval request to Redis (TTL until expiry). */
async function storeApprovalRequest(request: ApprovalRequest): Promise<void> {
  const redis = getRedis();
  const key = approvalKey(request.sessionId, request.toolCallId);
  const ttlSeconds = Math.ceil((request.expiresAt - Date.now()) / 1000);
  try {
    await redis.setex(key, Math.max(ttlSeconds, 1), JSON.stringify(request));
  } catch (err) {
    console.error("Failed to store approval request in Redis:", err);
  }
}

/** Read the recorded decision (approved/denied) from the key, if any. */
async function readRecordedDecision(key: string): Promise<boolean | undefined> {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ApprovalRequest;
    return typeof parsed.approved === "boolean" ? parsed.approved : undefined;
  } catch (err) {
    console.error("Failed to read approval decision from Redis:", err);
    return undefined;
  }
}

/**
 * Persist the decision in the key (source of truth for other processes) and
 * publish a `tool_approval_resolved` event on the session bus so waiting
 * agents in any process and all connected clients learn about it.
 */
async function recordDecisionAndNotify(
  request: ApprovalRequest,
  outcome: "approved" | "denied" | "cancelled",
): Promise<void> {
  const redis = getRedis();
  const key = approvalKey(request.sessionId, request.toolCallId);

  try {
    const raw = await redis.get(key);
    const base = raw ? (JSON.parse(raw) as ApprovalRequest) : request;
    let ttl = await redis.ttl(key);
    if (ttl < 0) ttl = Math.ceil((request.expiresAt - Date.now()) / 1000);
    // The key stops counting as pending either way, so a cancelled request can
    // never linger in a client's snapshot as "awaiting approval".
    const record =
      outcome === "cancelled"
        ? { ...base, cancelled: true, resolvedAt: Date.now() }
        : { ...base, approved: outcome === "approved", resolvedAt: Date.now() };
    await redis.setex(key, Math.max(ttl, RESOLVED_KEY_MIN_TTL_S), JSON.stringify(record));
  } catch (err) {
    console.error("Failed to record approval decision in Redis:", err);
  }

  publishSessionEvent(request.sessionId, "tool_approval_resolved", {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    approved: outcome === "approved",
    ...(outcome === "cancelled" ? { cancelled: true } : {}),
    expiresAt: new Date(request.expiresAt).toISOString(),
  } satisfies ApprovalResolutionData).catch((err) => {
    console.error("Failed to publish approval resolution event:", err);
  });
}

// ─── Approval Gate ───────────────────────────────────────────────────────────

/**
 * Wait for user approval for a tool call.
 *
 * Stores the request in Redis (persists across process restarts) and waits
 * for the user's decision. Resolves as soon as any of these happens:
 * - `resolveApproval` in this process (fast path)
 * - a `tool_approval_resolved` event on the session bus (any process: web
 *   UI, Telegram callback, another Next.js instance)
 * - the deadline (`expiresAt`) — denied; the denial is recorded and
 *   announced so no stale approval can outlive the wait
 * - the abort signal (agent stopped) — the request is cancelled, not denied:
 *   no decision is recorded for the user, but the card is closed so it cannot
 *   linger as "awaiting approval" after the run is gone
 *
 * @param request - The approval request data.
 * @param signal - Optional AbortSignal; when aborted, the wait ends with
 *   "aborted" immediately instead of waiting out the deadline.
 * @returns How the request ended.
 */
export async function waitForApproval(
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  // Fire-and-forget persistence: the key coordinates cross-process
  // resolution. The wait itself must NEVER depend on Redis round-trips —
  // the deadline timer is armed synchronously below so a tool call can
  // never hang past its expiry even if Redis is slow or unavailable.
  void storeApprovalRequest(request);
  const key = approvalKey(request.sessionId, request.toolCallId);

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeBus: (() => void) | null = null;

    const onAbort = () => {
      void concludeAsAborted();
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (unsubscribeBus) {
        unsubscribeBus();
        unsubscribeBus = null;
      }
      signal?.removeEventListener("abort", onAbort);
      pendingApprovals.delete(request.toolCallId);
    };

    const settle = (outcome: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    /**
     * Deadline/abort handling: first check whether a decision was recorded
     * in Redis (e.g. `resolveApproval` ran in another process and its
     * pub/sub notification was missed), otherwise record a denial and
     * notify observers so clients clear the approval card.
     */
    const concludeAtDeadline = async () => {
      const decision = await readRecordedDecision(key);
      if (decision !== undefined) {
        settle(decision ? "approved" : "denied");
        return;
      }
      await recordDecisionAndNotify(request, "denied");
      settle("denied");
    };

    /**
     * The run was stopped before the user decided. A decision that landed in
     * the meantime (another process, a Telegram tap) still wins; otherwise the
     * request is recorded as cancelled — the user denied nothing.
     */
    const concludeAsAborted = async () => {
      const decision = await readRecordedDecision(key);
      if (decision !== undefined) {
        settle(decision ? "approved" : "denied");
        return;
      }
      await recordDecisionAndNotify(request, "cancelled");
      settle("aborted");
    };

    timer = setTimeout(
      () => {
        void concludeAtDeadline();
      },
      Math.max(request.expiresAt - Date.now(), 0),
    );

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Cross-process path: the resolution event arrives on the session bus.
    // The listener is installed after the Redis write, so a resolution that
    // lands in between is caught either live or by the deadline re-read.
    subscribeSessionEvents(request.sessionId, (evt) => {
      if (evt.event !== "tool_approval_resolved") return;
      const data = evt.data as ApprovalResolutionData;
      if (!data || data.toolCallId !== request.toolCallId) return;
      settle(data.approved ? "approved" : "denied");
    }).then((unsubscribe) => {
      if (settled) {
        unsubscribe();
      } else {
        unsubscribeBus = unsubscribe;
      }
    });

    // Same-process fast path: resolveApproval resolves this entry directly.
    pendingApprovals.set(request.toolCallId, { resolve: settle, timer });
  });
}

/**
 * Resolve a pending approval (called from the approval API or Telegram callback).
 *
 * Writes the decision into the Redis key (source of truth across processes),
 * publishes a `tool_approval_resolved` bus event (cross-process delivery +
 * client notification), and resolves the in-process wait if it exists.
 *
 * @returns true if a pending approval was resolved, false if it was already
 *   resolved or has expired.
 */
export async function resolveApproval(
  sessionId: string,
  toolCallId: string,
  approved: boolean,
): Promise<boolean> {
  const redis = getRedis();
  const key = approvalKey(sessionId, toolCallId);

  let existing: ApprovalRequest;
  try {
    const raw = await redis.get(key);
    if (!raw) return false;
    existing = JSON.parse(raw) as ApprovalRequest;
  } catch (err) {
    console.error("Failed to read approval request from Redis:", err);
    return false;
  }

  // Idempotent: already resolved (another tab, Telegram, timeout) or cancelled
  // because the run ended while the request was pending.
  if (typeof existing.approved === "boolean" || existing.cancelled === true) return false;

  // Record the decision + notify BEFORE the in-process fast path so a waiting
  // agent in another process can observe it even if its pub/sub delivery fails.
  await recordDecisionAndNotify(existing, approved ? "approved" : "denied");

  // Same-process fast path.
  const pending = pendingApprovals.get(toolCallId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingApprovals.delete(toolCallId);
    pending.resolve(approved ? "approved" : "denied");
  }

  return true;
}

/**
 * Get all pending (unresolved, unexpired) approval requests for a session.
 */
export async function getPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
  const redis = getRedis();
  const pattern = `${APPROVAL_KEY_PREFIX}${sessionId}:*`;
  const keys: string[] = [];
  let cursor = 0;

  do {
    const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 50);
    cursor = Number(result[0]);
    keys.push(...(result[1] as string[]));
  } while (cursor !== 0);

  if (keys.length === 0) return [];

  const values = await redis.mget(keys);
  return values
    .filter((v): v is string => v !== null)
    .map((v) => {
      try {
        return JSON.parse(v) as ApprovalRequest;
      } catch {
        return null;
      }
    })
    .filter((r): r is ApprovalRequest => r !== null)
    .filter(
      (r) => r.expiresAt > Date.now() && typeof r.approved !== "boolean" && r.cancelled !== true,
    );
}

// ─── Tool Wrapper ────────────────────────────────────────────────────────────

/**
 * Wait for user approval and return the result.
 *
 * Shared by the tool wrapper (built-in and Saale tools) and by the MCP tool
 * policy extension, which gates tools registered by Pi's MCP extension instead
 * of wrapped at session creation.
 */
export async function requestToolApproval(options: {
  toolCallId: string;
  toolName: string;
  userId: string;
  sessionId: string;
  args: Record<string, unknown>;
  emitApprovalRequest: (request: ApprovalRequest) => void;
  signal?: AbortSignal | undefined;
  /** The calls this one decision covers, when they are more than the call. */
  batch?: ApprovalBatch;
}): Promise<ApprovalOutcome> {
  const { toolCallId, toolName, userId, sessionId, args, emitApprovalRequest, signal } = options;

  // Resolve "what is this call about" before the card appears, so the user
  // can judge the action from a single line (ID-only references are looked
  // up against the user's own records). Never blocks the gate on failure.
  const summary = await resolveApprovalSummary(userId, toolName, args);

  const request: ApprovalRequest = {
    toolCallId,
    toolName,
    sessionId,
    userId,
    args,
    summary,
    ...(options.batch ? { batch: options.batch } : {}),
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
  };

  // Persist BEFORE announcing the request: the SET is queued on the same
  // Redis connection ahead of the event publish (FIFO), so the key is
  // visible before any client can learn about the request — clients that
  // reconcile against Redis (approvals snapshot) can never miss it.
  void storeApprovalRequest(request);

  emitApprovalRequest(request);

  const outcome = await waitForApproval(request, signal);

  if (outcome === "denied") {
    console.error(`Tool call "${toolName}" was denied (timeout or rejection).`);
  }

  return outcome;
}

/**
 * Wrap a tool definition with an approval gate.
 *
 * Before every tool execution, the wrapper checks:
 * 0. Policy: "off" → reject immediately (even during auto-approve mode)
 * 1. Auto-approve mode (/stfu) active for the user → execute immediately,
 *    bypassing "ask" and risky "auto" approvals (never re-enables "off" tools)
 * 2. Policy: "ask" → emit approval request, wait for user decision
 * 3. Policy: "allow" → proceed
 * 4. Policy: "auto" → command-aware (infra_exec only): auto-approve safe commands, ask for risky ones
 *
 * The original tool code is never modified.
 */
export function wrapWithApprovalGate(
  tool: ToolDefinition,
  userId: string,
  sessionId: string,
  getPolicy: (toolName: string) => Promise<ToolPolicy>,
  emitApprovalRequest: (request: ApprovalRequest) => void,
): ToolDefinition {
  const originalExecute = tool.execute;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const policy = await getPolicy(tool.name);

      // Policy: "off" — tool is disabled. Never overridden, not even by
      // auto-approve mode (/stfu): a disabled tool stays disabled.
      // Thrown, not returned: Pi's agent loop hardcodes `isError: false` for
      // any non-throwing tool result, so a returned error would reach the
      // model and the UI as a successful call.
      if (policy === "off") {
        throw new Error(`Tool "${tool.name}" is disabled.`);
      }

      // Auto-approve mode (/stfu): accept tool use requests for this user
      // until the window expires — bypasses "ask" and risky "auto"
      // approvals, regardless of per-tool preferences.
      if (await isAutoApproveActive(userId)) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      // Policy: "auto" — command-aware approval (infra_exec, bash)
      if (policy === "auto" && COMMAND_AWARE_TOOLS.has(tool.name)) {
        const command = (params as { command?: string }).command;
        const classification = command
          ? classifyCommand(command)
          : { safety: "risky", reason: "no command provided" };

        if (classification.safety === "risky") {
          const outcome = await requestToolApproval({
            toolCallId,
            toolName: tool.name,
            userId,
            sessionId,
            args: params as Record<string, unknown>,
            emitApprovalRequest,
            signal,
          });

          if (outcome === "aborted") {
            throw new Error(TOOL_ABORT_MESSAGE);
          }
          if (outcome !== "approved") {
            throw new Error(
              `Tool call "${tool.name}" was denied by the user (approval timed out or explicitly rejected).`,
            );
          }
        }
        // Safe command — proceed without approval
      }

      // Policy: "ask" — wait for user approval
      if (policy === "ask") {
        // …unless the user already approved it as part of the script that
        // announced it: that decision covers this call.
        if (isApprovalScopeGranted({ sessionId, toolCallId, toolName: tool.name })) {
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }

        const outcome = await requestToolApproval({
          toolCallId,
          toolName: tool.name,
          userId,
          sessionId,
          args: params as Record<string, unknown>,
          emitApprovalRequest,
          signal,
        });

        if (outcome === "aborted") {
          throw new Error(TOOL_ABORT_MESSAGE);
        }
        if (outcome !== "approved") {
          throw new Error(
            `Tool call "${tool.name}" was denied by the user (approval timed out or explicitly rejected).`,
          );
        }
      }

      // "allow", "auto" (safe), or approved — proceed
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * Build the approval gate applied to every tool of a chat session.
 *
 * Encapsulates the policy lookup so every entry point that creates a chat
 * agent (the stream route, `/compact`, Telegram) enforces the same rule:
 * the user's stored policy for the tool, else the tool's built-in default.
 *
 * @param emitApprovalRequest - Publishes the request to whoever can answer it
 *   (the web session event bus, a Telegram card, …).
 */
export function createToolApprovalGate(options: {
  userId: string;
  sessionId: string;
  toolPolicies: Record<string, string> | null | undefined;
  emitApprovalRequest: (request: ApprovalRequest) => void;
}): (tool: ToolDefinition) => ToolDefinition {
  const getPolicy = async (toolName: string): Promise<ToolPolicy> =>
    resolveToolPolicy(toolName, { toolPolicies: options.toolPolicies });

  return (tool) =>
    wrapWithApprovalGate(
      tool,
      options.userId,
      options.sessionId,
      getPolicy,
      options.emitApprovalRequest,
    );
}

/**
 * Approval emitter for a chat session: publishes the request on the session
 * event bus, so every connected client — in any process — shows the approval
 * card (the web UI, Telegram, an agent's own channel).
 */
export function createChatApprovalEmitter(sessionId: string): (request: ApprovalRequest) => void {
  return (request) => {
    publishSessionEvent(sessionId, "tool_approval_request", toApprovalPayload(request)).catch(
      (err) => {
        console.error("Failed to publish approval request:", err);
      },
    );
  };
}
