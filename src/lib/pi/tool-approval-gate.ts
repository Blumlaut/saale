import { getRedis } from "@/lib/redis";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-tool approval policy. */
export type ToolPolicy = "off" | "ask" | "yolo";

/** How long an approval request waits before auto-denying (ms). */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Redis key prefix for pending approvals. */
const APPROVAL_KEY_PREFIX = "saale:approval:";

/**
 * Pending approval promises: toolCallId → { resolve, timer }.
 * Cleared when resolved or on timeout.
 */
interface PendingEntry {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingEntry>();

/**
 * Request data stored in Redis for persistence across restarts.
 */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  userId: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

// ─── Approval Gate ───────────────────────────────────────────────────────────

/**
 * Wait for user approval for a tool call.
 *
 * Stores the request in Redis (survives process restarts).
 * Returns a promise that resolves when the user approves/denies or on timeout.
 *
 * @param request - The approval request data.
 * @returns true if approved, false if denied or timed out.
 */
export function waitForApproval(request: ApprovalRequest): Promise<boolean> {
  const redis = getRedis();
  const key = `${APPROVAL_KEY_PREFIX}${request.sessionId}:${request.toolCallId}`;
  const ttlSeconds = Math.ceil((request.expiresAt - Date.now()) / 1000);

  // Store in Redis for persistence
  redis.setex(key, Math.max(ttlSeconds, 1), JSON.stringify(request)).catch((err) => {
    console.error("Failed to store approval request in Redis:", err);
  });

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () => {
        pendingApprovals.delete(request.toolCallId);
        resolve(false);
      },
      Math.max(request.expiresAt - Date.now(), 0),
    );

    pendingApprovals.set(request.toolCallId, { resolve, timer });
  });
}

/**
 * Resolve a pending approval (called from the approval API or Telegram callback).
 *
 * @returns true if the approval was found and resolved.
 */
export async function resolveApproval(
  sessionId: string,
  toolCallId: string,
  approved: boolean,
): Promise<boolean> {
  const redis = getRedis();
  const key = `${APPROVAL_KEY_PREFIX}${sessionId}:${toolCallId}`;

  // Check if approval exists
  const existing = await redis.get(key);
  if (!existing) {
    return false;
  }

  // Clean up Redis key
  await redis.del(key).catch((err) => {
    console.error("Failed to clean up approval key from Redis:", err);
  });

  // Try to resolve in-process
  const pending = pendingApprovals.get(toolCallId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingApprovals.delete(toolCallId);
    pending.resolve(approved);
    return true;
  }

  return true; // Was stored in Redis even if not resolved in-process
}

/**
 * Get all pending approval requests for a session.
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
    .map((v) => JSON.parse(v) as ApprovalRequest)
    .filter((r) => r.expiresAt > Date.now());
}

// ─── Tool Wrapper ────────────────────────────────────────────────────────────

/**
 * Wrap a tool definition with an approval gate.
 *
 * Before every tool execution, the wrapper checks:
 * 1. Policy: "off" → reject immediately
 * 2. Policy: "ask" → emit approval request, wait for user decision
 * 3. Policy: "yolo" → proceed
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

      // Policy: "off" — tool is disabled
      if (policy === "off") {
        return {
          content: [{ type: "text", text: `Tool "${tool.name}" is disabled.` }],
          isError: true,
          details: {},
        };
      }

      // Policy: "ask" — wait for user approval
      if (policy === "ask") {
        const request: ApprovalRequest = {
          toolCallId,
          toolName: tool.name,
          sessionId,
          userId,
          args: params as Record<string, unknown>,
          createdAt: Date.now(),
          expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
        };

        emitApprovalRequest(request);

        const approved = await waitForApproval(request);

        if (!approved) {
          return {
            content: [
              {
                type: "text",
                text: `Tool call "${tool.name}" was denied by the user (approval timed out or explicitly rejected).`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      }

      // "yolo" or approved — proceed
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
