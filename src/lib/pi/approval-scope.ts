/**
 * Approval scopes: one decision that covers the calls a tool makes while it runs.
 *
 * A tool that orchestrates other tools (`codemode`, whose script calls several)
 * can ask the user once for everything it is about to do. The calls it then
 * makes are *nested*. Pi ids them `<calling id>/<n>`. and each one would
 * otherwise ask again, because the gate that sees a nested call only knows the
 * call in front of it: it cannot tell whether the user just approved the parent.
 *
 * A grant therefore records the decision against the call that was approved,
 * and every gate consults it before putting a nested call to the user.
 *
 * Process-local on purpose. The nested calls run in the process that awaited
 * the approval (the grant is written there the moment the wait settles, whether
 * the tap came from the web UI, another process or Telegram), so a Redis
 * round-trip on every gated call would carry nothing. A grant dies with the call
 * it belongs to and expires with the approval window as a backstop, so an
 * aborted run cannot leave one behind.
 */

/** One approval and the tools it stands in for. */
interface ScopeGrant {
  tools: Set<string>;
  expiresAt: number;
}

/** sessionId → the id of the approved call → its grant. */
const grants = new Map<string, Map<string, ScopeGrant>>();

/**
 * The call id and the ids of the calls it was nested in, innermost first
 * `call_a/2/1` is `["call_a/2/1", "call_a/2", "call_a"]`.
 */
function callAndAncestors(toolCallId: string): string[] {
  const segments = toolCallId.split("/");
  const ids: string[] = [];
  for (let end = segments.length; end > 0; end--) {
    ids.push(segments.slice(0, end).join("/"));
  }
  return ids;
}

/** Record that `tools` are approved for the calls made by `toolCallId`. */
export function grantApprovalScope(options: {
  sessionId: string;
  toolCallId: string;
  tools: readonly string[];
  expiresAt: number;
}): void {
  const { sessionId, toolCallId, tools, expiresAt } = options;
  if (tools.length === 0) return;

  const session = grants.get(sessionId) ?? new Map<string, ScopeGrant>();
  grants.set(sessionId, session);

  const now = Date.now();
  for (const [id, grant] of session) {
    if (grant.expiresAt <= now) session.delete(id);
  }

  session.set(toolCallId, { tools: new Set(tools), expiresAt });
}

/** Forget a call's grant. called when the approved call finishes. */
export function releaseApprovalScope(sessionId: string, toolCallId: string): void {
  const session = grants.get(sessionId);
  if (!session) return;
  session.delete(toolCallId);
  if (session.size === 0) grants.delete(sessionId);
}

/**
 * Whether the call `toolCallId` is covered by an approval granted to it or to a
 * call it was nested in. the approved call is covered along with everything it
 * goes on to make. A grant covers a call by tool name: the same tool called
 * again under the approved parent is still covered, a different one is not.
 */
export function isApprovalScopeGranted(options: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
}): boolean {
  const session = grants.get(options.sessionId);
  if (!session) return false;

  const now = Date.now();
  for (const id of callAndAncestors(options.toolCallId)) {
    const grant = session.get(id);
    if (!grant) continue;
    if (grant.expiresAt <= now) {
      session.delete(id);
      continue;
    }
    if (grant.tools.has(options.toolName)) return true;
  }

  if (session.size === 0) grants.delete(options.sessionId);
  return false;
}
