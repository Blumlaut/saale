---
name: pi-agent-usage
description: Conventions and gotchas for using the Pi agent SDK (@earendil-works/pi-coding-agent) in Saale. Use when creating AI sessions, setting system prompts, calling models, or integrating the Pi agent for any task (email drafts, chat, queue jobs, etc.).
---

# Pi Agent Usage Conventions

Rules and patterns for using `@earendil-works/pi-coding-agent` in Saale.

## Critical: `session.prompt()` vs `agent.prompt()`

**Chat and Telegram: use `session.prompt(text, { images? })` — the same path the Pi TUI uses. Always pass a system-prompt resource loader to `createAgentSession` (see System Prompts).**

`session.prompt()` runs the AgentSession preflight + post-run processing that
`session.agent.prompt()` (the raw core agent loop) bypasses:

- **Pre-prompt compaction check** (catches stale/overflowed contexts)
- **Post-run auto-compaction** at the `agent_end` boundary (real context size
  vs. `contextWindow - reserveTokens`, never mid-run, never aborts the run)
- **Error retry** and **overflow recovery** (compact + `agent.continue()`)
- **`agent_settled`** — the "completely finished" event. `agent_end` only
  means the run iteration stopped; the run may still continue.

Since pi v0.86 the system prompt is derived from the session's **resource
loader** (replayed from the transcript), not from a settable string — the
private `_baseSystemPrompt`/`_systemPromptOverride` fields no longer exist, and
`agent.state.systemPrompt` is read-only. Set the prompt by passing
`resourceLoader: await createSystemPromptLoader(prompt, cwd)` to
`createAgentSession` — do NOT set `session.agent.state.systemPrompt` directly
(it is a derived property the SDK overwrites).

```ts
// ✅ CORRECT for chat/Telegram — TUI-parity prompt path
const { session } = await createAgentSession({
  /* ... */
  resourceLoader: await createSystemPromptLoader(buildAgentSystemPrompt({ ... }), cwd),
});
await session.prompt(userMessage);            // resolves on agent_settled
// or with images:
await session.prompt(userMessage, { images });

// ❌ WRONG for chat/Telegram — bypasses compaction, retry, agent_settled
session.agent.prompt(userMessage);
```

**Never call `session.compact()` from the event tracker or mid-run.**
`AgentSession.compact()` is the MANUAL path: it aborts the in-flight run
first, and firing it more than once (it has no in-flight guard) double-compacts
the session. Compaction is the SDK's job; the session event tracker only
observes `compaction_start`/`compaction_end` and persists the summary.

Use `session.agent.prompt(text, images)` ONLY for short one-shot jobs where
post-run processing is irrelevant:

- Queue jobs: `src/lib/queue/job-handler.ts` (`dispatchAiJob`)
- Email drafts: `src/app/api/email/draft/route.ts`

Chat stream (`src/app/api/chat/sessions/[sessionId]/stream/route.ts`) and the
Telegram processor (`src/lib/telegram/processor.ts`) use `session.prompt()`.

## System Prompts

**Always set a custom system prompt.** Never rely on the default Pi base prompt (it contains coding-agent noise irrelevant to end users).

Provide it via a resource loader at session creation — this is the only
mechanism that survives the SDK's per-turn prompt resolution (see Critical
section above):

```ts
import { buildAgentSystemPrompt, createSystemPromptLoader } from "@/lib/pi/processing-state";

const { session } = await createAgentSession({
  /* ... */
  resourceLoader: await createSystemPromptLoader(
    buildAgentSystemPrompt({ customInstructions, toolConfig }),
    cwd, // session dir for chat sessions, process.cwd() for one-shot jobs
  ),
});

// ... later ...
await session.prompt(userMessage);
```

`createSystemPromptLoader(prompt, cwd)` (from `src/lib/pi/processing-state.ts`)
wraps `DefaultResourceLoader` with discovery disabled (no extensions/skills/
context files) — Saale builds its own prompts and runs headless. It calls
`await loader.reload()` because `createAgentSession` does NOT reload a
caller-provided loader.

`buildAgentSystemPrompt()` builds the Saale assistant prompt from the user's
custom instructions + tool config.
One-shot jobs (email drafts, queue jobs) that set a bespoke prompt should use
`createSystemPromptLoader(bespokePrompt, cwd)` as well.

The final prompt the model sees is the custom prompt (preamble section) plus a
small `<cwd>` section — no tools/rules/docs sections, since a custom prompt
replaces them.

### Prompt conventions by feature

| Feature     | Prompt style                                                         | Reference                                               |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Chat        | `buildAgentSystemPrompt()` (assistant + custom instructions + tools) | `src/app/api/chat/sessions/[sessionId]/stream/route.ts` |
| Email draft | Task-specific, output-only rules                                     | `src/app/api/email/draft/route.ts`                      |
| Queue jobs  | JSON-only, structured output                                         | `src/lib/queue/job-handler.ts`                          |

## Model Runtime

**Always use `buildModelRuntime(userId)` from `src/lib/pi/models`** (or
`buildGlobalModelRuntime()` for the admin's global configuration). This creates a
`ModelRuntime` whose providers, models and credentials are all Pi's — Saale adds
none of its own except the OpenAI-compatible endpoint.

```ts
import { buildModelRuntime } from "@/lib/pi/models";

const { modelRuntime, models } = await buildModelRuntime(userId);
```

**Never call `ModelRuntime.create()` bare.** Its defaults read the _host's_
`~/.pi/agent/auth.json`, `models.json` and `models-store.json` (SDK docs,
"Credential priority"), so a server running on a machine where the operator uses
Pi would hand every tenant that operator's provider keys, private endpoints and
catalog cache. `buildModelRuntime` passes Saale's own stores:

```ts
{
  credentials: createProviderCredentialStore(scope),  // src/lib/providers/credential-store.ts
  modelsPath: null,
  modelsStore: createModelsStore(),                   // src/lib/providers/models-store.ts (Redis)
  allowModelNetwork: false,
}
```

Keep it that way. (Environment-provided keys — `ANTHROPIC_API_KEY` etc. — are
still honoured by the SDK, so keep provider keys out of the app's environment
too.)

### Providers, credentials and models are Pi's

**Never add a provider, a model or an auth field to Saale.** Pi's runtime already
knows every provider it can talk to, how each authenticates, and which models it
serves; the settings UI lists `modelRuntime.getProviders()`
(`src/lib/providers/catalog.ts`) and signs in through Pi's own flows
(`src/lib/providers/login.ts`). A provider Pi gains appears in Saale with no
change here.

- **Credentials** live in `provider_api_key.encryptedCredential`, one encrypted
  Pi `Credential` (`{ type: "api_key", key, env }` or an OAuth token set) per
  provider per scope. `encryptedKey` is the OpenAI-compatible endpoint's key
  only. A user reads their own credential and inherits the global one.
- **Sign-in** runs Pi's `login(providerId, authType, interaction)` detached, with
  the interaction transported over Redis so a browser can answer it. Browser-OAuth
  flows bind a loopback callback on the _server_, which the user's browser cannot
  reach — Pi's flows all offer a headless path (device code, copy code, or pasting
  the final redirect URL), and its own instructions tell the user which.
- **Model lists** come from Pi's catalog, plus the overlay Pi fetches from
  `pi.dev` (cached in Redis, refreshed detached; `PI_OFFLINE` disables it —
  Pi itself only consults that variable on `create()`).
- **The one exception** is `custom`: an OpenAI-compatible endpoint Pi does not
  know, registered with `registerProvider` (its key via `setRuntimeApiKey`) and
  described by Saale's own limits and capability map. `definesProviderModels()`
  in `src/lib/providers/config.ts` is true for it alone.

### Resolving a specific model

**Use `modelRuntime.getModel(provider, modelName)`.** The returned definition is
the one to pass to `createAgentSession` — do not copy or adjust it:

```ts
const { modelRuntime, models } = await buildModelRuntime(userId);
const model = modelRuntime.getModel(provider, modelName);
```

**Never raise `model.maxTokens`.** pi-ai's `buildBaseOptions` sends the model's
`maxTokens` as the request's `max_tokens` (clamped to `contextWindow`), so it
must describe the real endpoint. Raising it to the context window makes
providers reject the whole request — DeepSeek answers
`400 Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`,
Anthropic and Mistral cap output well below their context windows too. When a
request fails this way `stopReason` is `"error"` with empty content, which looks
like a silent no-op rather than an error.

For the OpenAI-compatible endpoint (the one provider Pi's catalog can't
describe), the limits come from the user's provider config (`contextWindow` /
`maxOutputTokens` on `provider_api_key`, applied via `limitFields()` in
`src/lib/providers/limits.ts`). Never invent those numbers in code.

### Available models (for UI lists)

`buildModelRuntime()` returns a `models` array already filtered by admin config. Use this for dropdowns and selectors.

## Session Creation

### Chat sessions

`src/lib/pi/chat-session-factory.ts` is the one place a chat's agent session is
built — the stream route and `/compact` both call it, so they cannot drift:

```ts
export async function createChatAgentSession(options: {
  userId: string;
  sessionId: string; // ChatSession.id
  chatSession: ChatSessionModelConfig; // model, thinking level, tool config
  model?: { provider: string; name: string }; // omitted → user's default chat model
  customInstructions: string | null;
  toolPolicies: Record<string, string> | null | undefined;
  /** The approval gate. Omitting it runs every tool unapproved. */
  wrapTool: (tool: ToolDefinition) => ToolDefinition;
  /** Approval channel for the tools Pi extensions register (see Codemode below). */
  emitApprovalRequest: (request: ApprovalRequest) => void;
}): Promise<{ session: AgentSession; sessionDir: string }>;
```

Build the gate with `createToolApprovalGate({ userId, sessionId, toolPolicies,
emitApprovalRequest })` (`src/lib/pi/tool-approval-gate.ts`) — it resolves each
tool's policy and wraps `wrapWithApprovalGate`, which is the only thing that
enforces the user's policies. Tools wrapped without it execute unapproved, so
`createChatAgentSession` requires it. For web chat, build the emitter with
`createChatApprovalEmitter(sessionId)` (publishes on the session event bus);
Telegram has its own (a card in the chat).

### Starting a session's extensions

`createAgentSession` does **not** emit `session_start`. Pi emits it from
`session.bindExtensions()`, and that is where extensions connect and register
their tools — so a session that is never bound has no MCP servers and no
`codemode` tool (registered inactive). Call `startSessionExtensions(session)`
(`src/lib/pi/processing-state.ts`) once after creating any session whose loader
includes extensions: it binds, then activates `codemode`.

### Codemode (on by default)

Saale runs Pi's `codemode` tool in every session that can call tools. The model
writes a short JavaScript script that calls tools through `ctx.executeTool()`,
which means **nested calls still go through Saale's approval gate** — the tools
it calls are the wrapped definitions in the session's registry, not raw ones.

- The extension comes from `createAgentResourceLoader()`; the tool is registered
  inactive and `startSessionExtensions()` activates it.
- Do **not** activate it through `defaultTools` in `createSessionSettings()`:
  Saale passes `noTools: "builtin"`, which makes Pi ignore `defaultTools`, and
  naming Pi's built-in tools would activate the _host's_ file/shell tools when
  Open Terminal is not configured.
- `noTools: "builtin"` still activates extension-registered tools that Saale
  supplies through `customTools` — that is how `read`/`bash`/`edit`/`write` and
  the Saale tool categories remain active.

#### The script is the approval unit

`codemode` is registered by its extension at `session_start`, so unlike Saale's
own tools it never passes through `wrapTool`. `createCodemodeApprovalExtension()`
(`src/lib/pi/codemode-approval.ts`, wired in `createAgentResourceLoader` under the
`interactive` context) gates it on the `tool_call` event instead.

A script's calls each carry their own policy, so gating them one by one puts a
card in front of the user per call — the same decision, asked N times. Instead
the script is the approval unit: one card **listing the calls that would ask on
their own**, and one click that stands in for all of them.

- **What a card covers** is read from the script source
  (`readScriptToolReferences`, `src/lib/pi/codemode-script.ts`; shared with the
transcript card) and resolved against the registry (`pi.getAllTools()` plus
  `pi.getActiveTools()`, Pi's own callable rule — `codemode` itself is
  `model-only`, so a script can never start a script).
- **Only `ask` tools are covered.** A command-aware `auto` tool (`bash`,
  `infra_exec`) keeps its per-call gate: its decision is made from the command,
  which only exists at the call, where a card can show it. A tool the script
  reaches by a computed name is covered by nothing and asks for itself — the
  card says so (`dynamic`).
- **The grant** is recorded by `grantApprovalScope()`
  (`src/lib/pi/approval-scope.ts`) against the call the user approved, and every
  gate — `wrapWithApprovalGate` and the MCP extension — consults
  `isApprovalScopeGranted()` before asking about a nested call
  (`<parent>/<n>`). It is process-local (the nested calls run where the wait
  settled), released when the script's result arrives, and expires with the
  approval window. **A new gate must consult it too**, or a covered call will ask
  again.
- **The policy for `codemode` itself** decides whether a script asks at all:
  `off` blocks scripts outright (nothing else can — no other gate sees them),
  `ask` always asks, and `auto` (the default) asks only when a script reaches a
  tool that would ask. `allow` runs the script as one step and leaves every call
  to its own policy. All three gates resolve policy through `resolveToolPolicy()`
  (`src/lib/pi/tool-policy.ts`) so they cannot disagree.
- `codemode` is in the tool catalog with no category (it is active whatever the
  category switches say), so the settings UI lists it in its own "Always active"
  group.

## MCP servers (per user)

`src/lib/mcp/` holds the whole feature: `shared.ts` (client-safe rules),
`servers.ts` (DB → Pi config), `probe.ts` (connection test).

- **Config lives in the database, not `mcp.json`.** `createUserMcpExtension(userId)`
  loads the user's enabled servers and passes them to `createMcpExtension({
loadConfig })`. Never let the MCP extension read the host's Pi directory: it
  belongs to whoever installed Pi on the machine.
- **HTTP only.** A stdio server is a command Pi spawns in the Saale process, so
  user-configured commands would run with the app host's environment and
  privileges. Users configure a URL plus an optional bearer token.
- **Exposure is always `codemode`.** MCP tools stay out of the model's tool
  declarations and are reached from codemode scripts, which Saale enables
  anyway — a server with hundreds of tools does not bloat every prompt.
- **MCP tools must be gated.** They are registered _after_ the session is built,
  so `wrapTool` never sees them. `createMcpToolPolicyExtension()` (an inline
  extension on `tool_call`) applies the user's per-tool policy, then the
  server's policy, then `ask`, and honours an approval scope an approved script
  already granted. Wire it wherever `createAgentResourceLoader` is called with
  an `interactive` context, and pass the same approval channel the session's
  tool gate uses.
- **A config change must evict the user's pooled chats** (`evictUserSessions`)
  — a pooled session's extensions are fixed at creation.
- **No server-to-client stream** (`createTransport` → `openGetStream: false`).
  Pi opens a long-lived GET stream per server by default, but a pooled session
  is evicted with `session.dispose()`, which does _not_ emit `session_shutdown`
  — the MCP extension only closes its connections there. With the default
  transport every evicted session would leak one open stream per server for the
  life of the process. The trade-off: a server whose tool list changes is
  re-read on the next connect, not mid-session.
- **OAuth servers are unsupported, and the host's sign-ins must stay out of
  reach.** Saale authenticates with the token the user stored. Pi's OAuth
  sign-in needs a browser, a loopback callback, and the `/mcp` overlay, none of
  which a hosted web app has, so the loader overrides `openUrl` to log and a
  token-less HTTP server just gets a 401 (the settings test explains it).
  `createUserMcpTransport` therefore drops Pi's `authProvider` entirely: its
  credentials live in `<agent directory>/mcp-auth.json`, a _host-wide_ file
  shared by the operator's Pi CLI and every tenant and keyed by server name and
  URL, so a session would otherwise silently present a sign-in the user never
  made. Adding OAuth later means `McpOAuthProvider` from
  `@earendil-works/pi-mcp/oauth` with Saale's own redirect URI and a per-user
  store — not re-enabling the default provider.
- **Interactive sessions only.** `createAgentResourceLoader` connects MCP for
  web chat and Telegram, which can both present an approval card. Unattended
  agent jobs pass no `interactive` context: they have no approval channel, so an
  `ask` server could only block, and running third-party tools unattended is not
  a decision this code makes for the user. (The same context gates `codemode`,
  for the same reason.)

```ts
const resourceLoader = await createAgentResourceLoader({
  prompt,
  cwd: sessionDir,
  interactive: { userId, sessionId, toolPolicies, emitApprovalRequest },
});
const { session } = await createAgentSession({ /* … */ resourceLoader });
await startSessionExtensions(session);
```

#### Changing a chat's settings

A pooled session's model, thinking level and tool loadout are fixed when it is
built. `PATCH /api/chat/sessions/:id` therefore also updates the live session
(`syncPooledAgentSession`): `session.setModel()` / `session.setThinkingLevel()`
for models and levels, and a pool eviction when the tool loadout changes (tools
are resolved from the config at creation). Writing only to the database leaves
the chat answering with the previous model until the session is evicted.

### Without tools (simple text generation like email drafts)

```ts
const { modelRuntime } = await buildModelRuntime(userId);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
  settingsManager: createSessionSettings(), // never the host's ~/.pi/agent settings
  noTools: "all", // disable everything
  model,
  customTools: [],
  resourceLoader: await createSystemPromptLoader(bespokePrompt, process.cwd()),
  thinkingLevel: "off", // one-shot jobs want a deterministic, cheap level
});
```

Use `noTools: "all"` when you don't need any tools. This is lighter than `noTools: "builtin"`.

## Thinking Levels

The SDK supports these thinking levels: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`. Not all models support all levels — the SDK clamps to
what the model supports.

**`src/lib/pi/thinking-levels.ts` is the single source of truth** for the level
list and for resolving a stored setting. `"default"` is Saale's extra setting:
it means "no opinion", and it must resolve to _no_ option so Pi keeps its own
level (the level recorded in the session file, the user's Pi setting, or Pi's
built-in default).

```ts
import { thinkingLevelOption } from "@/lib/pi/thinking-levels";

await createAgentSession({
  /* ... */
  ...thinkingLevelOption(session.thinkingLevel), // omitted for "default"
});
```

Passing a level explicitly always overrides Pi — that includes `"off"`, which is
why `"off"` and `"default"` are different settings. Never write
`thinkingLevel: value || "off"`: it silently converts "no opinion" into an
override.

Store settings with `normalizeThinkingLevelSetting()`; `/api/models/thinking-levels`
reports the levels a specific model supports for UI filtering.

## Streaming Responses

For SSE streaming (chat, email drafts), subscribe to the session and forward events:

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      // Forward cumulative text as `token` events
      break;
    case "agent_settled":
      // Run completely finished (after any compaction/retry) — emit `done`,
      // close stream. NOT agent_end: that only stops one run iteration and
      // the SDK may continue (auto-compaction, overflow retry).
      break;
  }
});
```

### Non-streaming (one-shot, queue jobs)

Use a Promise + subscribe pattern with timeout:

```ts
return new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error("AI task timed out (5min)"));
  }, 5 * 60_000);

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end") {
      clearTimeout(timer);
      unsubscribe();
      // Extract text from last assistant message
      resolve(text);
    }
  });

  session.agent.prompt(prompt);
});
```

Reference: `src/lib/queue/job-handler.ts` (`dispatchAiJob`)

## Chat Send Queue

Messages submitted while a generation runs are queued instead of rejected
(`ChatMessage.queuedAt`): they stay out of the conversation and render in the
composer's queue strip (`src/components/chat/queued-messages.tsx`).

- **Delivery** — the stream route drains the queue (`src/lib/chat/drain-queue.ts`):
  at run settle it claims the oldest queued message and prompts it as its own run
  (`session.prompt()`, re-wiring persistence), then repeats. It runs server-side,
  so queued messages are answered even when every client has navigated away.
- **Send now** — `POST /queue/:messageId` steers the message into the running
  agent (`session.steer`) when the session is streaming in this process; otherwise
  the message stays queued (409) and the drain delivers it in order.
- **One tracker per run** — `wireSessionPersistence()` replaces the previous
  run's tracker, and a new run must `await waitForPersistenceTeardown(sessionId)`
  first. Wiring mid-teardown leaves the run unpersisted and double-publishes
  every stream event.
- **Transcript queries must exclude queued rows** (`queuedAt: null`) — the
  conversation, shared chats, title generation and memory extraction all do.

## Message Editing (History Rewind)

`PATCH /messages/:messageId` rewrites the DB history: the message is updated in
place and everything after it is deleted. The Pi transcript is **append-only**,
so the DB write alone is not enough — a plain re-prompt appends the edited text
after the messages the edit deleted, and the model reads the edit as a brand new
message following the old conversation.

- The edit route leaves a rewind request in Redis
  (`setPendingHistoryRewind`) with the pre-edit content and the message's index
  among the session's saved user messages.
- The stream connection that prompts the edited message applies it first
  (`applyPendingHistoryRewind`) — `session.navigateTree()` on the message's
  transcript entry, Pi's own "edit an earlier message" primitive. It moves the
  leaf to the entry's parent, so the prompt replaces the message. The
  abandoned branch stays in the JSONL but drops off the active path. Since pi
  v0.87 the `SessionManager` is canonical for the provider context (every
  request is rebuilt from its projection), so moving the leaf is the whole
  rewind — `navigateTree()` resyncs the agent's public state itself. The root
  case (edited first message, no parent entry) uses
  `sessionManager.resetLeaf()` + `session.refreshContext()` instead.
- Read-then-claim the request: a rewind belongs to one specific message, and
  consuming it while prompting an unrelated one throws the edit away.
- Never guess which entry to rewind to — a wrong pick deletes history. Match on
  the DB position, verified against the pre-edit content, then fall back to the
  closest content match; skip the rewind when nothing matches.
- Rewinding past a compaction entry drops the summary from the active path (the
  entries it summarized are still there) — editing pre-compaction history means
  reverting to pre-compaction context, the same as Pi's TUI.

## Anti-Patterns

| Anti-pattern                                                                       | Why                                                                                                                                                                                                                                                       | Fix                                                                                                                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardcoding a provider list, a base URL, or a model catalog                         | Pi's runtime already knows every provider, how it authenticates and which models it serves; a hand-kept list drifts, and `registerProvider` _replaces_ a provider's model list, dropping the metadata Pi had (`thinkingLevelMap`, `compat`, input limits) | Read `modelRuntime.getProviders()`; authenticate through Pi's own `login()` flows (`src/lib/providers/login.ts`)                            |
| Storing a provider's API key in a field Saale invents                              | Pi's credential is not always one key — Cloudflare needs an account and gateway id, Bedrock and Azure resolve ambient config, OAuth stores tokens that Pi refreshes                                                                                       | Let Pi produce the credential and store it whole (`encryptedCredential`, one encrypted `Credential` per provider)                           |
| `session.agent.prompt()` for chat/Telegram                                         | Bypasses SDK compaction, retry, `agent_settled` — treats a stopped run as finished                                                                                                                                                                        | Use `session.prompt()` (with a system-prompt resource loader)                                                                               |
| Re-prompting an edited message without rewinding the transcript                    | The append-only transcript still holds the deleted history, so the model reads the edit as a new message                                                                                                                                                  | Rewind first — see "Message Editing (History Rewind)"                                                                                       |
| Calling `session.compact()` on token thresholds / mid-run                          | Aborts the in-flight run; no in-flight guard → double compaction                                                                                                                                                                                          | Let the SDK auto-compact at run boundaries; only observe `compaction_*` events                                                              |
| Treating `agent_end` as "done"                                                     | Run may continue after compaction/error retry                                                                                                                                                                                                             | Emit `done` on `agent_settled`                                                                                                              |
| `getAvailable()[0]` for model                                                      | Grabs first model (could be an embedding model)                                                                                                                                                                                                           | Use user's `defaultModelProvider`/`defaultModelName` from AppSettings                                                                       |
| No custom systemPrompt                                                             | Pi base prompt has coding-agent noise                                                                                                                                                                                                                     | Always pass `resourceLoader: await createSystemPromptLoader(prompt, cwd)`                                                                   |
| Setting `session.agent.state.systemPrompt` or private `_baseSystemPrompt`          | Removed in pi v0.86 (read-only derived property)                                                                                                                                                                                                          | Use `createSystemPromptLoader` at session creation                                                                                          |
| Assigning `session.agent.state.messages`                                           | Since pi v0.87 the provider context comes from the `SessionManager` projection — the assignment compiles but no longer affects future requests                                                                                                            | Navigate with `session.navigateTree()`; for direct `sessionManager` mutations call `session.refreshContext()` after                         |
| `noTools: "builtin"` for text-only tasks                                           | Heavier than needed                                                                                                                                                                                                                                       | Use `noTools: "all"`                                                                                                                        |
| Activating `codemode` via `defaultTools` while passing `noTools`                   | Pi ignores `defaultTools` when `noTools` is set, and naming built-in tools would activate the _host's_ file/shell tools                                                                                                                                   | `startSessionExtensions(session)` after `createAgentSession`                                                                                |
| Never calling `session.bindExtensions()`                                           | Extensions never get `session_start`: no MCP connections, no codemode activation                                                                                                                                                                          | `startSessionExtensions(session)`                                                                                                           |
| Gating MCP tools by wrapping them                                                  | They are registered after the session is built, so `wrapTool` never sees them — `ask`/`off` would be ignored                                                                                                                                              | `createMcpToolPolicyExtension()` on `tool_call`                                                                                             |
| Letting the MCP extension read the host's `mcp.json` / `mcp-auth.json`             | Config and credentials belong to the machine's Pi install, not to a tenant                                                                                                                                                                                | `createUserMcpExtension(userId)` with `loadConfig`; override `logPath`/`openUrl`/`updateConfig`                                             |
| No timeout on non-streaming calls                                                  | Can hang indefinitely                                                                                                                                                                                                                                     | Always add a timeout (5min default)                                                                                                         |
| Returning `{ isError: true }` from a tool                                          | Pi's agent loop hardcodes `isError: false` for non-throwing results, so the failure reaches the model and the UI as a successful call                                                                                                                     | `throw new Error("…")` — the loop turns it into a flagged error result with the message                                                     |
| Omitting `settingsManager` from `createAgentSession`                               | Pi then reads the _host's_ `~/.pi/agent/settings.json`: thinking level, compaction budget, retries, image blocking, proxy, and a `packages` list it resolves (npm install!) on every session creation                                                     | Pass `createSessionSettings()` (`src/lib/pi/settings.ts`)                                                                                   |
| Passing `authStorage`/`modelRegistry` to `createAgentSession`                      | Deprecated API (pre-0.80.8)                                                                                                                                                                                                                               | Use `modelRuntime` instead                                                                                                                  |
| Returning `null` exit code from custom `BashOperations` for killed/failed commands | pi v0.86 treats null as failure ("Command terminated without an exit code"), not partial success                                                                                                                                                          | Throw `Error("aborted")` / `Error("timeout:<secs>")` for abort/timeout; keep null only when no exit code exists (e.g. container cleaned up) |
| Letting Saale's codemode discovery port drift from Pi                              | A watcher runs in Saale's own sandbox, so `codemode-discovery.ts` re-implements Pi's discovery helpers; a script moved from a chat must see one surface. Pi v1.2.0 dropped the suffix heuristic for `namespace.aliases`, so a stale port stops matching   | Re-port `isNamespaceName()` from Pi's `extensions/codemode/execute.js`                                                                      |

## Custom BashOperations (Open Terminal)

`src/lib/terminal/operations.ts` implements Pi's `BashOperations` against the
Open Terminal REST API. The tool renders `exec` errors as tool output, so
signal failures through the SDK's conventions:

- **timeout** → throw `new Error(\`timeout:${seconds}\`)` → rendered as "Command timed out after N seconds" (output included)
- **abort** → throw `new Error("aborted")` → rendered as "Command aborted" (output included)
- **no exit code** (404 during status poll) → return `{ exitCode: null }` → "Command terminated without an exit code"

Never swallow a `killCommand` failure — log it (repo rule: no swallowed errors).

**Never forward the `env` the SDK hands `exec()`.** It is the _server's_
environment (`resolveSpawnContext` copies `process.env`), so passing it on ships
`DATABASE_URL`, `ENCRYPTION_KEY` and `OPEN_TERMINAL_API_KEY` into the container,
where any command the model runs can read them. Open Terminal merges what you
send into the container's own environment, so send only `extraEnv` (GH_TOKEN)
and the container's PATH/HOME stay intact.
