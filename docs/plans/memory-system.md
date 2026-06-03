# Memory System — Plan

Persistent knowledge base the AI maintains automatically from chat history.
The user never manages it directly — it's extracted, searched, and pruned in the background.

---

## Problem

- Chat history is ephemeral context, not knowledge. Once a session ends or the
  context window rolls, facts and decisions are lost.
- `chat_search` is keyword-only on raw messages — brittle and noisy.
- The AI has no way to "remember" things across sessions without re-reading
  entire chat histories.

## Goals

- **Automatic.** The user and the conversational AI never manually create memories.
  Extraction runs as a background job.
- **On-demand retrieval.** The AI searches memory when it doesn't know something,
  not forced into every context window.
- **Bounded context.** Summarization and extraction never exceed model limits.
- **Conservative.** Better to miss a memory than clutter the knowledge base.

---

## Architecture

```
Chat Session
    │
    ▼
┌──────────────────┐
│ Extraction Job   │  runs every X hours, processes unsummarized messages
│ (background)     │
└────────┬─────────┘
         │ extracts
         ▼
┌──────────────────┐
│ Memory Store     │  Prisma-backed, collections + tags
│ (PostgreSQL)     │
└────────┬─────────┘
         │ searched via
         ▼
┌──────────────────┐
│ memory_search    │  tool available in AI sessions
│ (on-demand)      │
└──────────────────┘
```

### Flow

1. User chats normally. No memory overhead during conversation.
2. Periodically, a background job finds chat sessions with unprocessed messages.
3. For each session, a lightweight model call extracts facts, decisions, and
   patterns — produces a running summary and candidate memories.
4. Candidates are deduplicated against existing memories and saved if novel.
5. During future conversations, if the AI doesn't know something, it calls
   `memory_search` to look it up.

---

## Data Model

### New Model

```prisma
model Memory {
  id           String   @id @default(cuid())
  userId       String
  collection   String   // "facts" | "projects" | "people" | "preferences" | "decisions"
  title        String
  content      String   @db.Text
  tags         String[] @default([])
  importance   Int      @default(5)   // 1-10, set by extraction model
  source       String?  // ChatSession.id this memory came from
  accessCount  Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([userId, collection])
  @@index([userId, tags])
}
```

### Changes to ChatSession

```prisma
model ChatSession {
  // ... existing fields ...

  lastSummarizedAt  DateTime?   // cursor — only process messages after this
  memorySummary     String?     @db.Text // compressed running summary of the conversation
}
```

`lastSummarizedAt` ensures we never re-process the same messages.
`memorySummary` is the incremental context passed to the extraction model
so it understands what's new vs. continuation.

---

## Context Overflow Prevention

A single chat can exceed any model's context window. Three guards:

### 1. Cursor-Based Processing

`lastSummarizedAt` acts as a read cursor. Each extraction run only fetches
messages created after the last run:

```ts
const newMessages = await prisma.chatMessage.findMany({
  where: {
    sessionId,
    createdAt: { gt: session.lastSummarizedAt },
  },
  orderBy: { createdAt: 'asc' },
});
```

If a session has 200 messages and 180 were already processed, only 20 are
fed to the model.

### 2. Running Summary

The extraction model outputs an updated `memorySummary` (~200-500 tokens).
This is included as context alongside new messages:

```
Input: [previous summary ~300 tokens] + [new messages ~5k tokens]
Output: { add: [...], summary: "updated..." }
```

Always well within limits even for active sessions.

### 3. Hard Token Cap

If new messages alone exceed a threshold (e.g., 15k tokens), truncate to the
most recent messages and include the running summary for lost context. The
extraction model is conservative — if something important was cut, it'll
likely appear again in future messages.

---

## Extraction Job

### Type

```ts
type: "memory_extraction"
```

### Schedule

Every 6 hours (configurable via job config).

### Pipeline

Added as a new branch in `job-handler.ts` alongside existing job types
(summarization, classification, etc.). Follows the same pattern:

```
1. Find ChatSessions where:
   - userId matches the task owner
   - lastSummarizedAt IS NULL OR lastSummarizedAt < session.updatedAt
   - messageCount > 0
   - ordered by updatedAt desc (newest activity first)
   - limited to maxSessionsPerRun

2. For each session (sequential, not parallel):
   a. Fetch new messages since lastSummarizedAt
   b. Truncate if raw messages exceed 15k tokens (keep newest + summary)
   c. Fetch existing categories: SELECT DISTINCT collection FROM Memory WHERE userId
   d. Fetch top N existing memories (ordered by importance desc, updatedAt desc)
   e. Build extraction prompt (summary + new messages + categories + existing memories)
   f. Call dispatchAiTask() with the prompt
   g. Parse JSON response — handle markdown code blocks, fallback on parse error
   h. Deduplicate candidates against existing memories (code-level, see below)
   i. Save new memories, delete/remove flagged ones
   j. Update ChatSession: lastSummarizedAt = now(), memorySummary = new summary

3. Log output: { sessionsProcessed, memoriesAdded, memoriesRemoved }
```

### Handler Placement

New `else if (type === "memory_extraction")` block in `processJob()`.
Follows the exact same error handling and run tracking pattern as existing
job types (create run → mark running → try/catch → mark completed/error).

### Extraction Prompt

```
You are a knowledge curator. Extract memorable information from this conversation.

Previous conversation summary:
"{memorySummary}"

New messages:
{newMessages}

Existing memory categories:
{existingCategories}

Existing memories (for deduplication — do not re-extract these):
{existingMemories}

Extract ONLY new information not already captured.

Categorization:
- Place each memory into one of the existing categories above
- Only create a new category if none of the existing ones fit the memory's purpose
- Category names should be lowercase, single words (e.g. "facts", "decisions", "projects")

Rules:
- Be conservative — only extract specific, concrete information
- Skip vague observations, small talk, and things already in existing memories
- If new info contradicts an existing memory, flag it for removal
- Set importance 1-10: explicit user statements = 8-10, inferred = 3-5

Output JSON:
{
  "add": [
    { "collection": "facts", "title": "...", "content": "...", "tags": ["..."], "importance": 7 }
  ],
  "remove": ["memory_id_1"],
  "summary": "updated running summary of the full conversation so far"
}
```

### Model Selection

Uses `dispatchAiTask()` which resolves the model via `resolveModelForPurpose()`.
No new purpose needed — passes empty string to fall through to the user's
global default model. Per-job `modelId` override supported via job config
(follows the same pattern as summarization/classification jobs).

### Job Schema

Registered in `job-schemas.ts` alongside existing job types:

```ts
{
  type: "memory_extraction",
  label: "Memory Extraction",
  description: "Extract facts, decisions, and patterns from chat history",
  icon: "Brain",
  defaultCron: "0 */6 * * *",   // every 6 hours
  usesAi: true,
  fields: [
    {
      key: "maxSessionsPerRun",
      label: "Max sessions per run",
      description: "Batch size — sessions processed per execution",
      type: "number",
      default: 10,
      min: 1,
      max: 50,
    },
    {
      key: "maxExistingMemories",
      label: "Context memories",
      description: "Existing memories included for deduplication (higher = more accurate, more tokens)",
      type: "number",
      default: 15,
      min: 5,
      max: 50,
    },
    {
      key: "modelId",
      label: "AI Model",
      description: "Override the default model for this task",
      type: "model",
      default: "",
    },
  ],
}
```

### Auto-Creation

The extraction job is **NOT auto-created**. The user creates it via the job
config UI (same flow as summarization, classification, etc.). This gives
the user control over when memory extraction starts and which model it uses.

### Concurrency

The extraction job processes sessions sequentially within a single job run
(not in parallel). The BullMQ worker already has `concurrency: 5` and a
rate limiter (`max: 10 per 60s`), so multiple users' extraction jobs are
handled naturally by the queue.

---

## Retrieval

### Tool: `memory_search`

```ts
memory_search({
  query: "how does auth work",
  collection?: "projects",   // optional filter
  tags?: ["saale"],          // optional filter
  limit?: 10                 // default 10
})
```

**Phase 1:** PostgreSQL full-text search. Store a `tsvector` computed from
`title` + `content` using `to_tsvector('english', ...)`. Query with `@@`
operator for proper stemming and ranking via `ts_rank`. Tags matched
separately via array overlap (`&&`).

No extensions needed — PostgreSQL's built-in full-text search suffices.
`pgvector` not required until Phase 4.

**Phase 2 (future):** Hybrid search with embeddings. Store a vector
embedding on `Memory` and use similarity search alongside keyword matching.

### System Prompt Instruction

Conditionally appended in `stream/route.ts` — only when the memory tool is
enabled for the session. The route already reads `toolConfig` from the chat
session; the memory instruction is added only if `toolConfig.memory !== false`:

```ts
const memoryInstruction = enabled.memory
  ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
  : "";

piSession.agent.state.systemPrompt = basePrompt + memoryInstruction;
```

If memory tools are disabled, the instruction is omitted entirely — no
point telling the AI about a tool it doesn't have.

No automatic injection. The AI decides when to search.

### Tool Registration

- `memory-tools.ts` — new file, exports `createMemoryTools(userId)`
  (follows the same factory pattern as `chat-tools.ts`, `mail-tools.ts`, etc.)
- `tool-config.ts` — add `memory?: boolean` to `ToolConfig`, default `true`
- `session.ts` — add memory tools to `allCustomTools` when `enabled.memory`
  is true (same pattern as email, calendar, web tools)

---

## Memory Lifecycle

### Creation
Extraction job creates memories from chat summaries. Importance 1-10.

### Access Tracking
Each `memory_search` that returns a memory increments its `accessCount` via
a bulk update (single query, not per-memory). Reset to 0 during pruning
runs so decay is measured from the last pruning cycle.

Used for pruning and ranking (higher access = more useful = keep longer).

### Decay / Pruning

A separate job type `memory_pruning` (weekly default):

```ts
{
  type: "memory_pruning",
  label: "Memory Pruning",
  description: "Remove stale and unused memories",
  icon: "ScissorsLine",
  defaultCron: "0 0 * * 0",   // weekly, Sunday midnight
  usesAi: false,               // no AI needed — pure DB logic
  fields: [
    {
      key: "unusedDays",
      label: "Unused threshold",
      description: "Delete memories with 0 accesses older than this many days",
      type: "number",
      default: 90,
      min: 30,
      max: 365,
    },
    {
      key: "lowImportanceDays",
      label: "Low importance threshold",
      description: "Delete memories with importance < 3 older than this many days",
      type: "number",
      default: 180,
      min: 60,
      max: 365,
    },
  ],
}
```

Rules:
- `accessCount === 0` AND older than `unusedDays` → delete
- `importance < 3` AND older than `lowImportanceDays` → delete
- After deletion, reset all remaining `accessCount` to 0 (new cycle)

No "archive" semantics — deletion is permanent. If the user needs something
back, it'll be re-extracted from chat history on the next extraction run
(since `memorySummary` is retained as context).

### Deduplication

Two layers:

**1. LLM-level (in the prompt).**
Existing memories are included in the extraction prompt. The LLM is
instructed not to re-extract things already present and to flag contradictions
via the `remove` array.

**2. Code-level (after parsing the response).**
For each candidate memory, compare against existing memories in the same
collection using simple overlap:
- Same collection + title word overlap > 50% → skip (duplicate)
- Same collection + title word overlap 25-50% → merge content into existing
- Otherwise → save as new

No embeddings needed. Title overlap is a good proxy since titles are short
and descriptive. Good enough for Phase 1.

---

## Phased Implementation

### Phase 1: Core Infrastructure

- [ ] Add `Memory` model to Prisma schema
- [ ] Add `lastSummarizedAt` and `memorySummary` to `ChatSession`
- [ ] Run migration
- [ ] Create `memory-tools.ts` with `memory_search` tool
- [ ] Register memory tool in `tool-config.ts` and `session.ts`
- [ ] Add system prompt instruction for memory usage

### Phase 2: Extraction Job

- [ ] Add `memory_extraction` job type to queue
- [ ] Implement extraction handler (fetch messages → call model → save memories)
- [ ] Implement cursor-based message fetching
- [ ] Implement running summary updates
- [ ] Implement deduplication against existing memories
- [ ] Add extraction prompt template

### Phase 3: Pruning

- [ ] Add `memory_pruning` job type
- [ ] Implement decay logic (access count, age, importance thresholds)
- [ ] Archive vs. delete semantics

### Phase 4 (Future): Semantic Search

- [ ] Add `embedding Byte[]?` to Memory model
- [ ] Integrate embedding model into extraction pipeline
- [ ] Upgrade `memory_search` to hybrid keyword + vector search
- [ ] Add reranking

---

## Open Questions

1. **Memory visibility.** Should the user see their memories in the UI?
   Useful for debugging and trust, but adds UI scope. Out of scope for now.

2. **Extraction prompt tuning.** The extraction prompt will need iteration.
   Start conservative (miss memories rather than create noise) and loosen
   based on real data. The job logs provide a feedback loop.

3. **Hard token cap threshold.** 15k tokens proposed for truncation. May
   need adjustment based on real chat lengths and model context windows.

---

## Dependencies

- **Queue system** (`src/lib/queue/`) — `dispatchAiTask()`, `addJobRun()`,
  `updateJobRun()`, BullMQ worker. No changes needed.
- **Job schemas** (`src/lib/queue/job-schemas.ts`) — add two new entries
  (`memory_extraction`, `memory_pruning`).
- **Job handler** (`src/lib/queue/job-handler.ts`) — add two new `else if`
  branches. Follows existing pattern exactly.
- **Tool system** (`src/lib/pi/session.ts`, `src/lib/pi/tool-config.ts`) —
  add memory tool category. Follows existing pattern.
- **Chat stream** (`src/app/api/chat/sessions/[sessionId]/stream/route.ts`) —
  append memory instruction to system prompt.
- **Prisma** — new `Memory` model, two new fields on `ChatSession`.
