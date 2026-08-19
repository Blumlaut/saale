---
name: pi-agent-usage
description: Conventions and gotchas for using the Pi agent SDK (@earendil-works/pi-coding-agent) in Saale. Use when creating AI sessions, setting system prompts, calling models, or integrating the Pi agent for any task (email drafts, chat, queue jobs, etc.).
---

# Pi Agent Usage Conventions

Rules and patterns for using `@earendil-works/pi-coding-agent` in Saale.

## Critical: `agent.prompt()` vs `session.prompt()`

**Always use `session.agent.prompt(text)` — never `session.prompt(text)`.**

`session.prompt()` runs AgentSession preflight logic that **resets `systemPrompt` back to the Pi base prompt** ("you are an expert coding assistant operating inside pi...") on every turn. This silently overwrites any custom system prompt you set.

`session.agent.prompt()` calls the underlying agent directly, preserving your custom system prompt.

```ts
// ✅ CORRECT — preserves custom system prompt
session.agent.state.systemPrompt = "Your custom prompt...";
session.agent.prompt(userMessage);

// ❌ WRONG — preflight logic resets systemPrompt to Pi base prompt
session.agent.state.systemPrompt = "Your custom prompt...";
session.prompt(userMessage); // silently overwrites systemPrompt!
```

This is the #1 gotcha. Every integration point in Saale uses `agent.prompt()`:
- Queue jobs: `src/lib/queue/job-handler.ts` (`dispatchAiJob`)
- Email drafts: `src/app/api/email/draft/route.ts`
- Chat stream: `src/app/api/chat/sessions/[sessionId]/stream/route.ts`

## System Prompts

**Always set a custom system prompt.** Never rely on the default Pi base prompt (it contains coding-agent noise irrelevant to end users).

Set it immediately after creating the session, before calling `agent.prompt()`:

```ts
const { session } = await createAgentSession({ /* ... */ });

session.agent.state.systemPrompt = `Your custom system prompt here.`;

// ... later ...
session.agent.prompt(userMessage);
```

### Prompt conventions by feature

| Feature | Prompt style | Reference |
|---------|-------------|-----------|
| Chat | Short, generic assistant prompt | `src/app/api/chat/sessions/[sessionId]/stream/route.ts` |
| Email draft | Task-specific, output-only rules | `src/app/api/email/draft/route.ts` |
| Queue jobs | JSON-only, structured output | `src/lib/queue/job-handler.ts` |

### Chat system prompt

The chat uses a short, generic prompt. No feature descriptions, no tool listings — the agent infers capabilities from available tools:

```ts
session.agent.state.systemPrompt =
  "You are a helpful AI assistant. Be concise, direct, and write natural responses.";
```

> **Future:** User-defined system prompt override will be stored in `ChatSession` or `AppSettings`. Until then, keep the hardcoded prompt minimal so it's easy to replace.

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
    case "agent_end":
      // Forward final text as `done` event, close stream
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
| `session.prompt()` | Resets systemPrompt to Pi base prompt | Use `session.agent.prompt()` |
| `getAvailable()[0]` for model | Grabs first model (could be an embedding model) | Use user's `defaultModelProvider`/`defaultModelName` from AppSettings |
| No custom systemPrompt | Pi base prompt has coding-agent noise | Always set `session.agent.state.systemPrompt` |
| `noTools: "builtin"` for text-only tasks | Heavier than needed | Use `noTools: "all"` |
| No timeout on non-streaming calls | Can hang indefinitely | Always add a timeout (5min default) |
| Passing `authStorage`/`modelRegistry` to `createAgentSession` | Deprecated API (pre-0.80.8) | Use `modelRuntime` instead |
