# Task for reviewer

Audit the tool approval system implementation in Saale. This is a safety/trust layer that intercepts tool calls, enforces per-tool policies, and requires user approval.

Verify the following against the spec:

1. **Single interception point**: All tool calls wrapped at registry level — `src/lib/pi/tool-registry.ts` passes a `wrapWithApproval` callback to every resolved tool. No individual tool code was modified.

2. **Policy options**: Per-tool policies are `off` (block), `ask` (require approval), `yolo` (always allow). Default is `yolo`.

3. **Simplified approval flow**: Only approve/deny — NO "always" or "session" scope options anymore.

4. **Pause mechanism**: Tool `execute` is async and awaits a Redis-backed promise (`waitForApproval`) that resolves when user responds or on 5-min timeout (auto-deny).

5. **SSE events**: `publishStreamEvent(sessionId, "tool_approval_request", ...)` pushes approval prompts to frontend via Redis pub/sub.

6. **Telegram inline buttons**: `src/lib/telegram/approval.ts` sends messages with ✅ Approve / ❌ Deny inline buttons. Callback data: `approve:{sessionId}:{toolCallId}` or `deny:{sessionId}:{toolCallId}`.

7. **Telegram callback handling**: Webhook at `src/app/api/integrations/telegram/webhook/[accountId]/route.ts` handles `callback_query` updates and calls `handleApprovalCallback`.

8. **Frontend approval card**: `src/components/chat/tool-approval-card.tsx` renders inline with countdown timer and approve/deny buttons. Integrated into `chat-interface.tsx` via `pendingApprovals` state and `tool_approval_request` SSE event listener.

9. **Settings UI**: `src/app/dashboard/settings/tabs/tools-tab.tsx` shows per-tool policy dropdowns (Allow/Ask/Block) populated from `ALL_TOOL_INFOS`.

10. **API route**: `src/app/api/chat/sessions/[sessionId]/approve-tool/route.ts` receives approve/deny payloads and calls `resolveApproval`.

11. **User isolation**: Every DB query is scoped to authenticated user.

12. **Error handling**: All catch blocks log errors with context.

Key files:
- `src/lib/pi/tool-approval-gate.ts` — Core gate logic (types, Redis storage, waitForApproval, resolveApproval)
- `src/lib/pi/tool-registry.ts` — Tool resolution with optional wrapper
- `src/lib/pi/session.ts` — Session deps with wrapTool option
- `src/lib/pi/persistent-session.ts` — Persistent session with wrapTool
- `src/app/api/chat/sessions/[sessionId]/stream/route.ts` — Stream route with approval wrapper
- `src/app/api/chat/sessions/[sessionId]/approve-tool/route.ts` — Approval API endpoint
- `src/lib/telegram/approval.ts` — Telegram notifications with inline buttons
- `src/app/api/integrations/telegram/webhook/[accountId]/route.ts` — Webhook with callback query handling
- `src/components/chat/tool-approval-card.tsx` — Frontend approval card
- `src/components/chat/chat-interface.tsx` — Chat interface with approval integration
- `src/app/dashboard/settings/tabs/tools-tab.tsx` — Settings UI for per-tool policies
- `src/app/dashboard/settings/types.ts` — Settings types with toolPolicies
- `src/app/api/settings/route.ts` — Settings API with toolPolicies
- `src/lib/pi/tool-infos.ts` — Static tool catalog for settings UI
- `__tests__/lib/pi/tool-approval-gate.test.ts` — Unit tests

Check for:
- Missing pieces (e.g., Telegram not sending notifications, SSE events not forwarded)
- Type safety issues
- Edge cases (timeout, double resolution, concurrent approvals)
- Security issues (user isolation, auth checks)
- Error handling completeness
- Whether the agent loop actually pauses during approval wait

Report any issues found, with file paths and line references.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```