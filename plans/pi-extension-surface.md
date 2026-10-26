# Pi's extension surface: approvals, UI, and Saale as a plugin

Investigation into moving Saale's tool approval onto Pi extensions, exposing
Pi's UI APIs (dialogs, notifications, status) to the web client, and how far
Saale itself could become an extension loaded from the admin plugins page.

Everything below was read out of `@earendil-works/pi-coding-agent` 1.4.0
(`dist/core/…`, `docs/extensions.md`, `docs/rpc-extension-ui.md`).

## What Pi hands an extension, and where Saale stands

| Capability                    | Pi API                                             | Saale today                                     |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Observe/authorize a call      | `pi.on("tool_call")`                               | only MCP + `codemode`; own tools use `wrapTool` |
| Rewrite a result              | `pi.on("tool_result")`                             | unused                                          |
| Rewrite input / prompt        | `input`, `context`, `before_agent_start`           | unused                                          |
| Add tools                     | `pi.registerTool` (+ exposure, namespace, hints)   | own tools via `customTools`, no extension       |
| Slash commands                | `pi.registerCommand`                               | own registry (`src/lib/commands`)               |
| Dialogs                       | `ctx.ui.select/confirm/input/editor`               | `noOpUIContext` → returns `undefined`/`false`   |
| Notifications, status, widget | `ctx.ui.notify/setStatus/setWidget`                | no-ops                                          |
| Custom terminal UI            | `ctx.ui.custom`, `setFooter`, `setEditorComponent` | impossible in a browser (TUI components)        |
| Providers, virtual models     | `pi.registerProvider/registerVirtualModel`         | own `buildModelRuntime`                         |
| Inter-extension channel       | `pi.events.emit/on`                                | unused                                          |

Two facts decide most of the design:

1. `tool_call` handlers are installed on the **agent** (`_installAgentToolHooks`,
   `dist/core/agent-session.js`), so they fire for every call: built-ins,
   `customTools`, extension tools, MCP tools, and nested `executeTool()` calls
   (those carry `parentToolCallId`). A blocked call becomes an error tool result
   carrying `reason` (`dist/agent-loop.js`, `prepareToolCall`).
2. `AgentSession.bindExtensions(bindings)` takes `uiContext` and `mode`
   (`dist/core/agent-session.d.ts`). `startSessionExtensions` passes `{}`, so
   every extension sees `hasUI: false`, `mode: "print"`, and the no-op UI.

## 1. Approvals as one extension

### Today

Three gates have to agree, and `tool-policy.ts` exists because they can drift:

- `wrapWithApprovalGate` around every tool `resolveTools` returns (`wrapTool`).
- `createMcpToolPolicyExtension` on `tool_call`, because MCP tools register
  after the session exists.
- `createCodemodeApprovalExtension` on `tool_call`, because `codemode` and the
  calls its scripts make never pass through the wrapper.

### What a single gate buys

- One place for `off` / `ask` / `allow` / `auto`, the auto-approve window, and
  approval scopes; `wrapTool` disappears from `createPersistentSession`,
  `resolveTools` and every caller.
- **Plugin tools become gated.** This is a live hole: a tool registered by a
  plugin loaded from the plugins page never passes `wrapTool`, matches neither
  `mcp__` nor `codemode`, and has no catalog entry, so `resolveToolPolicy` falls
  back to `getDefaultPolicy` — but nothing calls it. The tool runs unapproved
  whatever the user's settings say, from the model and from a codemode script.
- Tools registered later (MCP, plugins, the `tool_search` activation path) are
  covered by construction.

### What changes behaviourally

| Concern         | Wrapper today                | `tool_call` gate                    |
| --------------- | ---------------------------- | ----------------------------------- |
| Denial          | `throw new Error("…denied")` | `return { block: true, reason }`    |
| Aborted run     | throw `TOOL_ABORT_MESSAGE`   | `block` with the stopped-run reason |
| Signal          | `execute`'s `signal`         | `ctx.signal` (run's signal)         |
| Args            | raw `params`                 | `event.input` (validated)           |
| Nested calls    | never seen                   | seen, `parentToolCallId` set        |
| Handler failure | n/a                          | blocks the call (fail-closed)       |

The `aborted` vs `denied` distinction only survives in the reason text, so the
message the model reads must be chosen per outcome. `tool_call` cannot skip the
tool's own execution once past the hook, which is fine: nothing gates later.

### Shape

```
createToolPolicyExtension({ userId, sessionId, toolPolicies, emitApprovalRequest })
  ├─ resolveToolPolicy(toolName, context)        // shared, unchanged
  ├─ off            → block
  ├─ auto-approve   → pass
  ├─ codemode call  → script batch + scope grant (existing logic, moved)
  ├─ nested call    → approval-scope lookup
  └─ ask            → requestToolApproval()
```

`withAbortSignal` stays on the definitions: it aborts a tool that is already
executing, which the hook cannot do. `approval-scope.ts` keeps working — the
scope is written against the approved call id, and nested ids still resolve
through `callAndAncestors`.

## 2. Pi's UI in a browser

`ctx.ui` is the whole TUI-facing surface. Half of it crosses a process boundary
cleanly, half is terminal rendering.

### Maps onto the web client

| `ctx.ui`                               | Saale equivalent                                      |
| -------------------------------------- | ----------------------------------------------------- |
| `select`, `confirm`, `input`, `editor` | the approval card's channel, rendered as a modal      |
| `notify(message, type)`                | `toast.info/warning/error`                            |
| `setStatus(key, text)`                 | a chat status strip (per-key, cleared by `undefined`) |
| `setWidget(key, lines, placement)`     | an above/below-composer panel                         |
| `setEditorText`, `pasteToEditor`       | composer draft                                        |
| `setTitle`                             | nothing worth wiring in an SPA                        |

### Does not map

`custom()`, `setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput`,
theme APIs, `setWorkingIndicator` — all take TUI component factories or raw
keyboard input. Pi's own RPC mode has the same limitation (`docs/rpc-extension-ui.md`
lists them as unsupported). **Overlays are TUI-only**; the nearest web
equivalent is a dialog or a widget, so a plugin asking for an overlay should be
told "no", not have it faked.

### Transport

Identical to approvals, which is the point — one channel, two payloads:

- server: `ExtensionUIContext` implementation that writes
  `saale:plugin-ui:<sessionId>:<id>` to Redis, publishes `plugin_ui_request` on
  the session bus, awaits a resolve (decision, timeout from `opts.timeout`,
  or `opts.signal` abort);
- client: modal/toast/widget stores keyed by session, fed by the existing SSE
  handler (`use-chat-stream.ts`) and included in the reconnect snapshot
  (`getPendingApprovals` gains a sibling);
- resolve route: `POST /api/chat/sessions/:id/ui-response`, owner-checked like
  `approve-tool`.

Pi already emits `ui_prompt_start`/`ui_prompt_end` session events around any
dialog, so a stuck dialog is visible in the existing activity/stop handling.

### Guard rails worth building in from the start

- Admin switch: plugin UI off by default; without it dialogs are refused
  immediately (`select` → `undefined`, `confirm` → `false`), which is what
  extensions are told to expect when `hasUI` is false.
- One dialog per session at a time, queued, with a hard cap — a plugin in a
  loop cannot make the chat unopenable.
- Timeout is mandatory: Pi's `timeout` when given, else a Saale default, and
  the resolve is announced like an approval so no card lingers.
- Unattended sessions (agent jobs, queue) get no `uiContext` at all. They have
  no client, and a blocking dialog there is a hung job.
- Every dialog is attributed to the plugin that asked (`pluginIdForPath` on the
  extension path, already available in the runner's context) so the modal can
  say who is asking.

## 3. Could Saale itself be a plugin?

### What a plugin can already do inside a Saale session

Because `createAgentResourceLoader` passes `additionalExtensionPaths` for every
session, plugins already get: `registerTool` (with exposure, namespace,
`reachesTools`, `prepareLoadout`, annotations), `tool_call`/`tool_result`,
`input`, `context`, `before_agent_start`, `registerMcpServer` (stdio included —
a spawned process in the app container), `registerProvider`,
`registerVirtualModel`, `appendEntry`, `sendMessage`, and, since
`expandPromptTemplates` is on, `registerCommand` — though unreachable from the
web composer, which intercepts `/name` and answers "Unknown command".

So the _hooks_ are all there. What is missing is everything tenant-specific.

### Blockers

1. **No identity in the factory.** `ExtensionAPI`'s factory argument carries no
   user or session; `SessionStartEvent` is `{ reason, previousSessionFile }`.
   The only in-band identity is the session manager's directory, which Saale
   names `pi_sessions/{userId}/{chatSessionId}`. Deriving a tenant from a path
   is not something to build a permission model on.
2. **No module resolution into Saale.** Plugin files load through jiti with
   Pi's own alias map and (in the published build) no tsconfig paths, so
   `import { prisma } from "@/lib/db"` fails, and a bare `@prisma/client` does
   not resolve from the plugins directory either. A Saale plugin could not read
   the database, the session bus or Redis.
3. **Plugins are global.** One directory loads into every session of every
   tenant, including unattended jobs. Saale's tools are per-user by
   construction (`createXxxTools(userId)` closing over the owner, per the
   isolation rule).
4. **Trust is already maximal, and that is the justification for keeping it
   admin-only.** A plugin shares the process, so `registerProvider` can inject
   credentials or endpoints for every tenant, and `registerMcpServer` can spawn
   a process. Shipping Saale's own tools through the same door adds no security
   _loss_, but it does put Saale's toolbox behind a switch an admin thinks is
   "other people's plugins".

### Verdict per subsystem

| Part of Saale                  | As an extension? | Why                                                             |
| ------------------------------ | ---------------- | --------------------------------------------------------------- |
| Approval gate                  | yes              | `tool_call`, no data access needed beyond policies              |
| UI channel                     | yes              | `uiContext` + the approval transport                            |
| Tool registration/ exposure    | yes (inline)     | `registerTool` replaces `customTools` + `applyToolExposure`     |
| Slash commands                 | yes (inline)     | needs a composer fallthrough for unknown names                  |
| System prompt                  | partly           | `before_agent_start` sections, but it is built from DB per user |
| Tool implementations           | no               | Prisma, Redis, sandbox client, per-user ownership               |
| Model runtime, credentials     | no               | per-user encrypted Pi credentials                               |
| Persistence, pooling, eviction | no               | the thing an extension would run inside                         |

### If a plugin-resident Saale is still wanted

Two mechanisms make it possible without violating isolation:

- **Context bus.** An inline Saale extension publishes `{ userId, sessionId }`
  on `pi.events` at `session_start` under a fixed channel name; a plugin reads
  it. Cheap, documented inter-extension pattern, and it keeps identity out of
  paths.
- **Host module.** Saale writes and versions a small `saale-host.mjs` into the
  plugins directory exposing a narrow, audited API (`db.forUser(userId)`,
  `approvals.request(...)`, `events.publish(...)`). More honest than jiti
  trickery, but it is a public API to maintain forever.

Even then, the plugins page would need to show Saale as a generated,
version-stamped, non-removable plugin whose switch cannot be turned off —
otherwise an admin can disable the app's own toolbox from a page labelled
"plugins".

## 4. Proposed sequence

Each phase ships on its own and leaves the current behaviour intact until the
next one.

0. **One approval gate.** Replace `wrapTool`, the MCP gate and the codemode gate
   with `createToolPolicyExtension`. Keep `tool-policy.ts`,
   `approval-scope.ts`, `auto-approve.ts` as they are. Tests: policy matrix,
   batch/scope, nested calls, abort vs deny, plugin tool gating.
1. **Plugin tool policies.** Catalog entries for tools whose source is a plugin,
   a per-plugin default policy setting, shown in the settings UI. Closes the
   hole from phase 0 for real, since `off` needs somewhere to be configured.
2. **UI channel.** `saaleExtensionUI()` implementing `ExtensionUIContext`,
   modal/toast/status/widget client pieces, resolve route, snapshot, admin
   switch, attribution, queueing and timeouts.
3. **Reachability.** Composer fallthrough for unknown `/commands` to
   `session.prompt()`; renderers for plugin custom messages if any plugin
   starts using `sendMessage`.

Phases 0–2 are internal rework; nothing a plugin author sees changes until
phase 2 turns `hasUI` on, which is also the first point where a third-party
plugin can block a run on a user's answer and should therefore land behind the
admin switch.

## Open questions

- Default policy for a tool nobody has configured: `ask` (fail closed, noisy)
  or `allow` (today's behaviour by accident)?
- Does the modal show a plugin's dialogs while the user is on another chat? The
  approval card is chat-scoped; a plugin dialog probably should be too.
- Telegram: reuse the same gate for dialogs (inline keyboards map onto
  `select`/`confirm`), or answer `undefined` and let plugins degrade?
- `notify` from an unattended job has nobody to notify — drop it, or persist it
  into the chat as an entry?
