---
name: pi-agent-usage
description: Conventions and gotchas for using the Pi agent SDK (@earendil-works/pi-coding-agent) in Saale. Use when creating AI sessions, setting system prompts, calling models, or integrating the Pi agent for any task (email drafts, chat, queue jobs, etc.).
---

# Pi Agent Usage Conventions

Rules and patterns for using `@earendil-works/pi-coding-agent` in Saale.

## Critical: `session.prompt()` vs `agent.prompt()`

**Chat and Telegram: use `session.prompt(text, { images? })` — the same path the Pi TUI uses. Always call `lockSystemPrompt()` first.**

`session.prompt()` runs the AgentSession preflight + post-run processing that
`session.agent.prompt()` (the raw core agent loop) bypasses:

- **Pre-prompt compaction check** (catches stale/overflowed contexts)
- **Post-run auto-compaction** at the `agent_end` boundary (real context size
  vs. `contextWindow - reserveTokens`, never mid-run, never aborts the run)
- **Error retry** and **overflow recovery** (compact + `agent.continue()`)
- **`agent_settled`** — the "completely finished" event. `agent_end` only
  means the run iteration stopped; the run may still continue.

The old gotcha — `session.prompt()` resetting the system prompt to the Pi base
prompt — is **neutralized by `lockSystemPrompt()`** (from
`src/lib/pi/processing-state.ts`): it replaces the SDK's `_baseSystemPrompt`
(the preflight's reset target) with the Saale prompt, and the per-turn prompt
resolution is `_systemPromptOverride ?? _baseSystemPrompt`. Set the prompt
with `lockSystemPrompt(session, prompt)` — do NOT set
`session.agent.state.systemPrompt` directly (it is a reflection property the
SDK overwrites).

```ts
// ✅ CORRECT for chat/Telegram — TUI-parity prompt path
lockSystemPrompt(session, buildAgentSystemPrompt({ ... }));
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

Set it with `lockSystemPrompt()` immediately after creating the session, before
calling `session.prompt()` — it is the only setter that survives the SDK's
preflight (see Critical section above):

```ts
import { buildAgentSystemPrompt, lockSystemPrompt } from "@/lib/pi/processing-state";

const { session } = await createAgentSession({ /* ... */ });

lockSystemPrompt(session, buildAgentSystemPrompt({ customInstructions, toolConfig }));

// ... later ...
await session.prompt(userMessage);
```

`buildAgentSystemPrompt()` (from `src/lib/pi/processing-state.ts`) builds the
Saale assistant prompt from the user's custom instructions + tool config.
One-shot jobs (email drafts, queue jobs) that set a bespoke prompt should use
`lockSystemPrompt(session, bespokePrompt)` as well.

### Prompt conventions by feature

| Feature | Prompt style | Reference |
|---------|-------------|-----------|
| Chat | `buildAgentSystemPrompt()` (assistant + custom instructions + tools) | `src/app/api/chat/sessions/[sessionId]/stream/route.ts` |
| Email draft | Task-specific, output-only rules | `src/app/api/email/draft/route.ts` |
| Queue jobs | JSON-only, structured output | `src/lib/queue/job-handler.ts` |

## Model Runtime

**Always use `buildModelRuntime(userId)` from `src/lib/pi/models`.** This creates a `ModelRuntime` with the user's configured providers and API keys.

```ts
import { buildModelRuntime } from "@/lib/pi/models";

const { modelRuntime, models } = await buildModelRuntime(userId);
```

### Resolving a specific model

**Always use `resolveModel(runtime, provider, modelName)` from `src/lib/pi/models`** — never `modelRuntime.getModel()` directly for inference.

Pi's built-in model definitions cap `maxTokens` well below `contextWindow` (often ~16k), and pi-ai falls back to `model.maxTokens` for the request's `max_tokens`. This truncates responses mid-thought when reasoning is on. `resolveModel()` returns a copy with `maxTokens` raised to the full context window:

```ts
import { resolveModel } from "@/lib/pi/models";

const model = resolveModel(modelRuntime, provider, modelName);
```

`modelRuntime.getModel()` is fine for metadata-only use (e.g. listing thinking levels).

### Available models (for UI lists)

`buildModelRuntime()` returns a `models` array already filtered by admin config. Use this for dropdowns and selectors.

## Session Creation

### With tools (chat, queue jobs that need tools)

```ts
const { session } = await createPiSession({
  userId,
  customTools: [],
  toolConfig,           // which tool categories to enable
  modelProvider,
  modelName,
  thinkingLevel: "off", // or user preference
});
```

Use `createPiSession` from `src/lib/pi/session.ts` — it handles model runtime, auth, and tool scoping.

### Without tools (simple text generation like email drafts)

```ts
const { modelRuntime } = await buildModelRuntime(userId);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
  noTools: "all",       // disable everything
  model,
  customTools: [],
  thinkingLevel: "off",
});
```

Use `noTools: "all"` when you don't need any tools. This is lighter than `noTools: "builtin"`.

## Thinking Levels

The SDK supports these thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Not all models support all levels — the SDK clamps to what the model supports. Use the full range in UI selectors and let the runtime handle compatibility.

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

## Anti-Patterns

| Anti-pattern | Why | Fix |
|-------------|-----|-----------|
| `session.agent.prompt()` for chat/Telegram | Bypasses SDK compaction, retry, `agent_settled` — treats a stopped run as finished | Use `session.prompt()` (with `lockSystemPrompt()` first) |
| Calling `session.compact()` on token thresholds / mid-run | Aborts the in-flight run; no in-flight guard → double compaction | Let the SDK auto-compact at run boundaries; only observe `compaction_*` events |
| Treating `agent_end` as "done" | Run may continue after compaction/error retry | Emit `done` on `agent_settled` |
| `getAvailable()[0]` for model | Grabs first model (could be an embedding model) | Use user's `defaultModelProvider`/`defaultModelName` from AppSettings |
| No custom systemPrompt | Pi base prompt has coding-agent noise | Always use `lockSystemPrompt(session, prompt)` |
| `noTools: "builtin"` for text-only tasks | Heavier than needed | Use `noTools: "all"` |
| No timeout on non-streaming calls | Can hang indefinitely | Always add a timeout (5min default) |
| Passing `authStorage`/`modelRegistry` to `createAgentSession` | Deprecated API (pre-0.80.8) | Use `modelRuntime` instead |
