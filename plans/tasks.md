# Tasks / To-Do

## Goal

Add a first-class **Task** concept to Saale — actionable items that live between a shopping list and a calendar event. Tasks have optional due dates, priorities, and tags, but no fixed time slots.

## Design Decisions

| Decision | Rationale |
|---|---|
| **Priority: low/medium/high** | Enum so we can expand later. Simple enough for users, structured enough for sorting. |
| **Tags (freeform)** | No categories for now — tags cover grouping needs. Add categories later if a pattern emerges. |
| **Flat (no subtasks)** | Keep it simple. Subtasks can be added later if needed. |
| **Completion separate from deletion** | Completed tasks go to an "archive" view. Deletion is permanent. |
| **No quick-add input bar** | Tasks will primarily come from AI (chat tool, email job). Manual creation via a modal/form is enough for v1. |
| **AI gets tools, decides aggression** | We expose `task_create`, `task_update`, `task_search` etc. The AI decides when to use them based on context. |
| **Email extraction as a job** | Configurable per email account. No "aggression level" — just on/off per account. |

## Task vs Calendar

| Calendar | Tasks |
|---|---|
| Fixed time slot ("2pm") | Time window ("today", "this week") |
| Meetings, appointments | Actions, follow-ups, errands |
| Start + end time | Optional due date, no fixed slot |
| You attend it | You complete it |

Tasks feed into the calendar: when you decide to work on a task, you create a calendar event from it. The task stays as the thing-to-do, the event is the time reserved.

## Database Schema

```prisma
model Task {
  id          String   @id @default(cuid())
  userId      String
  title       String
  description String?  @db.Text
  status      String   @default("pending") // "pending" | "completed"
  priority    String   @default("medium")  // "low" | "medium" | "high"
  dueDate     DateTime? // Date-only — stored at midnight UTC, rendered as a date in the user's timezone
  tags        String[] @default([])
  order       Int      @default(0)          // Manual sort within groups (drag reorder)
  source      String   @default("manual")  // "manual" | "chat" | "email_extraction"
  sourceEmailId String? // EmailMessage.id — no FK (cross-model traceability, resolved via separate query)
  completedAt DateTime?
  notifiedAt  DateTime? // Last time a due-date notification was sent for this task
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status, dueDate])
  @@index([userId, status, priority])
  @@map("Task")
}
```

**Relations:** Add `tasks Task[]` to the `User` model.

**Why these fields:**
- `status` instead of `isCompleted` — leaves room for "cancelled" or "in-progress" later
- `dueDate` is date-only (midnight UTC) — tasks have no fixed time slot, only a target date. The UI renders it in the user's local timezone.
- `source` + `sourceEmailId` — traceability back to where the task came from. `sourceEmailId` is a plain string (no Prisma relation), resolved with a separate query when the user clicks through from a task to its source email.
- `order` — persists drag-to-reorder within groups. Grouping (overdue/today/etc.) is primary sort; `order` is secondary within the same bucket.
- `completedAt` — separate from `updatedAt`, needed for "completed X days ago" sorting
- `notifiedAt` — prevents duplicate notifications. Checked before sending: only notify if `notifiedAt` is null or earlier than the notification window.
- No `projectId` or `categoryId` — tags cover grouping for now

## AI Tools

### `task_create`

```ts
defineTool({
  name: "task_create",
  label: "Create Task",
  description: "Create a new task. Use when the user asks to remember something, sets a reminder, or mentions an action item.",
  parameters: Type.Object({
    title: Type.String({ description: "What needs to be done." }),
    description: Type.Optional(Type.String({ description: "Additional details." })),
    priority: Type.Optional(Type.Union([
      Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")
    ], { description: "Priority level. Default: medium." })),
    dueDate: Type.Optional(Type.String({ description: "ISO date string (e.g. '2025-07-15'). Optional." })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for grouping." })),
  }),
  // ...
});
```

### `task_update`

```ts
defineTool({
  name: "task_update",
  label: "Update Task",
  description: "Update an existing task — change title, priority, due date, or mark as completed.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID." }),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    dueDate: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed")])),
  }),
  // ...
});
```

### `task_list_pending`

```ts
defineTool({
  name: "task_list_pending",
  label: "List Pending Tasks",
  description: "Get all pending tasks, sorted by due date then priority. Use to review what's open before creating new tasks or deciding what to work on next.",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ description: "Maximum results. Default: 50." })),
  }),
  // ...
});
```

### `task_search`

```ts
defineTool({
  name: "task_search",
  label: "Search Tasks",
  description: "Search tasks by title, description, tags, or status. Use to find existing tasks before creating duplicates. Results include task IDs for reference in update/delete operations.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Search in titles and descriptions." })),
    status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed")])),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    dueBefore: Type.Optional(Type.String({ description: "ISO date — tasks due before this date." })),
    tag: Type.Optional(Type.String({ description: "Filter by tag." })),
  }),
  // ...
});
```

### `task_delete`

```ts
defineTool({
  name: "task_delete",
  label: "Delete Task",
  description: "Permanently delete a task. Use sparingly — prefer marking as completed.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID." }),
  }),
  // ...
});
```

## Email Extraction Job

New job type: `"task_extraction"`. Follows the same pattern as `email_to_calendar` — single `accountId` select field (leave empty = all accounts), user creates multiple job instances for different accounts.

### Job Fields (matches existing pattern)

```ts
export const fields = [
  {
    key: "accountId",
    label: "Email Account",
    description: "Leave empty to scan all enabled email accounts",
    type: "select" as const,
    default: "",
    options: [] as Array<{ value: string; label: string }>,
  },
  {
    key: "limit",
    label: "Batch size",
    description: "Number of emails to scan per run",
    type: "number" as const,
    default: 20,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "maxEmailAge",
    label: "Max email age",
    description: "Only scan emails received within this many hours (0 = no limit)",
    type: "number" as const,
    default: 48,
    min: 0,
    max: 720,
    step: 1,
  },
  {
    key: "modelId",
    label: "AI Model",
    description: "Model used for task extraction",
    type: "model" as const,
    default: "",
  },
];
```

### Behavior

- Scans unprocessed emails (`taskScanned == false`) on the configured account(s)
- Delegates to `extractTasksFromEmails()` (new lib module, analog to `extractEventsFromEmails`)
- Uses the AI to extract action items from email content
- Creates tasks with `source: "email_extraction"` and `sourceEmailId` linking back
- Marks emails as task-scanned (`taskScanned: true`)

### New DB Field

```prisma
// On EmailMessage model:
taskScanned Boolean @default(false) // has the task extraction job processed this email?
```

Follows the same pattern as existing `calendarScanned` and `classified` fields.

## API Routes

### CRUD

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks` | List tasks (filterable by status, priority, due date, tags) |
| `POST` | `/api/tasks` | Create task |
| `GET` | `/api/tasks/[id]` | Get single task |
| `PATCH` | `/api/tasks/[id]` | Update task |
| `DELETE` | `/api/tasks/[id]` | Delete task |
| `PATCH` | `/api/tasks/bulk` | Bulk update (e.g. mark multiple as completed) |

### Query Params for GET /api/tasks

- `status` — `pending` | `completed`
- `priority` — `low` | `medium` | `high`
- `dueBefore` / `dueAfter` — ISO dates
- `tag` — filter by tag
- `source` — `manual` | `chat` | `email_extraction`
- `sort` — `dueDate` | `priority` | `createdAt` (default: `dueDate`)
- `limit` / `offset` — pagination

## Frontend

### New Page: `/dashboard/tasks`

Grouped list view (no calendar grid):

```
┌─────────────────────────────────────────────┐
│  Tasks                                    +  │
├─────────────────────────────────────────────┤
│  Overdue (1)                               │
│  ☐ Submit expense report         🔴 yesterday│
├─────────────────────────────────────────────┤
│  Today (2)                                 │
│  ☐ Follow up with Sarah on contract  📧 🔶  │
│  ☐ Review PR #42                  💬        │
├─────────────────────────────────────────────┤
│  This Week (3)                             │
│  ☐ Pick up dry cleaning              Fri    │
│  ☐ Book dentist appointment           🔴 Sat│
│  ☐ Update portfolio                    Wed  │
├─────────────────────────────────────────────┤
│  Someday (4)                               │
│  ☐ Research new hosting provider             │
│  ...                                         │
└─────────────────────────────────────────────┘
```

**Grouping buckets:**
- Overdue (due before today, pending)
- Today (due today, pending)
- This Week (due within 7 days, pending)
- Someday (no due date, pending)
- Completed (status = completed, collapsed by default)

**Visual cues:**
- Priority: 🔴 high, 🔶 medium, ⚪ low (subtle, not overwhelming)
- Source badges: 📧 email, 💬 chat (small, on the right)
- Completed tasks: strikethrough title, muted

**Interactions:**
- Click checkbox → toggle completed
- Click row → open detail/edit panel (slide-over or modal)
- Drag to reorder within groups (manual ordering override)
- "+" button → create task modal (title, description, priority, due date, tags)

### Sidebar Entry

Add "Tasks" to the dashboard sidebar navigation alongside Chat, Mail, Calendar, Jobs, Settings.

### Notification Integration

Tasks due today/tomorrow trigger notifications via the existing Redis-based notification system (`POST /api/notifications`).

- A new background job ("task_reminders", runs daily at 08:00) scans for pending tasks due within 24 hours
- Creates a notification per task: `"Task due today: {title}"` with type `"task_reminder"`
- Only notifies once per task: checks `notifiedAt` is null or earlier than the current notification window before sending, then sets `notifiedAt = now()`
- The notification bell UI auto-picks up the new type via its default icon fallback

## Files to Create

### Database
- `prisma/migrations/xxxx_add_tasks/` — migration for Task model + EmailMessage.taskScanned

### Backend
- `src/lib/pi/tools/task-tools.ts` — AI tool definitions (task_create, task_update, task_list_pending, task_search, task_delete)
- `src/lib/tasks/task-extraction.ts` — AI extraction logic (analog to `lib/calendar/email-extraction.ts`)
- `src/lib/queue/jobs/task-extraction.ts` — job handler (delegates to lib module)
- `src/lib/queue/jobs/task-reminders.ts` — daily reminder job for due-date notifications
- `src/app/api/tasks/route.ts` — list + create
- `src/app/api/tasks/[id]/route.ts` — get + update + delete
- `src/app/api/tasks/bulk/route.ts` — bulk operations

### Frontend
- `src/app/dashboard/tasks/page.tsx` — tasks page (server component — fetches initial data)
- `src/components/tasks/task-list.tsx` — grouped task list (client component — drag reorder, checkbox state)
- `src/components/tasks/task-item.tsx` — individual task row (client component — checkbox, click handlers)
- `src/components/tasks/task-form.tsx` — create/edit form (modal, client component)
- `src/components/tasks/task-groups.tsx` — grouping sections (server component — receives grouped data from page)

### Tool Registry
- Register task tools in `src/lib/pi/tool-registry.ts`
- Add "tasks" category to `src/lib/pi/tool-categories.ts` (single source of truth — types, defaults, and UI all derive from here)

## Files to Modify

### Database
- `prisma/schema.prisma` — add `Task` model, `tasks` relation on `User`, `taskScanned` on `EmailMessage`

### Backend
- `src/lib/pi/tool-categories.ts` — add "tasks" category (types, defaults, and UI toggles all auto-derive)
- `src/lib/queue/jobs/registry.ts` — register task extraction + task reminders handlers (`job-schemas.ts` auto-derives from registry)

### Frontend
- `src/components/layout/dashboard-nav.tsx` — add Tasks to sidebar nav
- Settings tools tab — auto-picks up new category from `tool-categories.ts` (no manual changes needed)

## Migration Steps

### Phase 1: Database
1. Add `Task` model to schema
2. Add `tasks Task[]` to `User` model
3. Add `taskScanned Boolean` to `EmailMessage`
4. Run migration

### Phase 2: AI Tools
5. Create `task-tools.ts` with 5 tool definitions (task_create, task_update, task_list_pending, task_search, task_delete)
6. Register tools in `tool-registry.ts`
7. Add "tasks" category to `tool-categories.ts` (auto-derives types, defaults, and settings UI toggle)
8. Test via chat ("add a task: pick up dry cleaning")

### Phase 3: API
9. Create CRUD API routes
10. Add bulk operations
11. Test all endpoints

### Phase 4: Frontend
12. Create tasks page with grouped list
13. Add sidebar navigation entry
14. Create task form modal
15. Add drag-to-reorder

### Phase 5: Email Extraction Job
16. Create `src/lib/tasks/task-extraction.ts` — AI extraction logic (analog to `lib/calendar/email-extraction.ts`)
17. Create `src/lib/queue/jobs/task-extraction.ts` — job handler (delegates to lib module)
18. Register in `jobs/registry.ts` (schemas auto-derive from handler metadata)
19. Test extraction from emails

### Phase 6: Notifications + Auto-Archive
20. Create `src/lib/queue/jobs/task-reminders.ts` — daily job scanning for pending tasks due within 24h, checks `notifiedAt` before sending, sets `notifiedAt = now()` after
21. Register reminder job in `jobs/registry.ts`
22. Test notification delivery (Redis-backed, existing bell UI renders automatically)
23. Add auto-archive logic: completed tasks older than 30 days are soft-deleted (or paginated out — decide based on volume)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| **AI creates duplicate tasks** | `task_list_pending` + `task_search` tools let AI review existing tasks before creating. Search results include task IDs for reference in update operations. |
| **Email extraction is too aggressive** | On/off per account via job instances. No aggression slider — AI uses conservative defaults. User can delete unwanted tasks. |
| **Tasks vs calendar confusion** | Clear visual distinction: tasks = list groups, calendar = time grid. No time slots on tasks. |
| **Completed tasks pile up** | Paginated API (limit/offset) keeps queries fast. Auto-archive in Phase 6 soft-deletes completed tasks older than 30 days. |
| **Drag reorder conflicts with due date sort** | Drag reorder only within groups. Grouping (overdue/today/this week/someday) is primary sort; `order` field is secondary within the same bucket. Persisted in DB so it survives refresh. |
| **`dueDate` timezone confusion** | Stored at midnight UTC, rendered as a date in the user's local timezone. The API returns ISO strings; the client formats them with date-only display. |

## What Doesn't Change

- **Calendar** — unchanged (events, CalDAV, ICS)
- **Email** — unchanged (sync, classification, summarization) — only adds `taskScanned` flag
- **Memory** — unchanged (tasks are separate from memories)
- **Chat** — unchanged (adds task tools to available toolset)
- **Notifications** — unchanged (tasks use existing notification API)
- **Jobs** — unchanged (adds two new job types: task_extraction, task_reminders)
