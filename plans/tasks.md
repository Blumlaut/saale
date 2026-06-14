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
  dueDate     DateTime?
  tags        String[] @default([])
  source      String   @default("manual")  // "manual" | "chat" | "email_extraction"
  sourceEmailId String? // Link back to EmailMessage if created by email extraction
  completedAt DateTime?
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
- `source` + `sourceEmailId` — traceability back to where the task came from
- `completedAt` — separate from `updatedAt`, needed for "completed X days ago" sorting
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

### `task_search`

```ts
defineTool({
  name: "task_search",
  label: "Search Tasks",
  description: "Search tasks by title, tags, or status. Use to find existing tasks before creating duplicates.",
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

New job type: `"task_extraction"`. Configurable per email account.

### Job Config

```json
{
  "enabled": true,
  "accounts": ["account-id-1", "account-id-2"],
  "cronExpression": "0 */6 * * *"  // every 6 hours
}
```

### Behavior

- Scans unread emails on configured accounts that haven't been task-scanned yet
- Uses the AI to extract action items from email content
- Creates tasks with `source: "email_extraction"` and `sourceEmailId` linking back
- Marks emails as task-scanned (new field on `EmailMessage`)

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

Tasks due today/tomorrow trigger notifications via the existing notification system:

- A background job (or the existing email sync job) checks for tasks due within 24 hours
- Creates a notification: `"Task due today: {title}"`
- Only notifies once per task (track via a `notifiedAt` field or check notification history)

## Files to Create

### Database
- `prisma/migrations/xxxx_add_tasks/` — migration for Task model + EmailMessage.taskScanned

### Backend
- `src/lib/pi/tools/task-tools.ts` — AI tool definitions (task_create, task_update, task_search, task_delete)
- `src/lib/queue/jobs/task-extraction.ts` — email-to-task extraction job
- `src/app/api/tasks/route.ts` — list + create
- `src/app/api/tasks/[id]/route.ts` — get + update + delete
- `src/app/api/tasks/bulk/route.ts` — bulk operations

### Frontend
- `src/app/dashboard/tasks/page.tsx` — tasks page
- `src/components/tasks/task-list.tsx` — grouped task list
- `src/components/tasks/task-item.tsx` — individual task row
- `src/components/tasks/task-form.tsx` — create/edit form (modal)
- `src/components/tasks/task-groups.tsx` — grouping sections (overdue, today, etc.)

### Tool Registry
- Register task tools in `src/lib/pi/tool-registry.ts`
- Add "tasks" to tool config schema in `src/lib/pi/tool-config.ts`

## Files to Modify

### Database
- `prisma/schema.prisma` — add `Task` model, `tasks` relation on `User`, `taskScanned` on `EmailMessage`

### Backend
- `src/lib/pi/tool-categories.ts` — add "tasks" category
- `src/lib/queue/job-schemas.ts` — add "task_extraction" job type
- `src/lib/queue/jobs/registry.ts` — register task extraction handler

### Frontend
- `src/app/dashboard/layout.tsx` — add Tasks to sidebar nav
- Settings tools tab — add "Tasks" toggle to default tool config

## Migration Steps

### Phase 1: Database
1. Add `Task` model to schema
2. Add `tasks Task[]` to `User` model
3. Add `taskScanned Boolean` to `EmailMessage`
4. Run migration

### Phase 2: AI Tools
5. Create `task-tools.ts` with 4 tool definitions
6. Register tools in tool registry
7. Add "tasks" to tool config
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
16. Create task extraction job handler
17. Register in job registry
18. Add job type to queue schemas
19. Test extraction from emails

### Phase 6: Notifications
20. Add due-date notification logic (background check)
21. Integrate with existing notification system
22. Test notification delivery

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| **AI creates duplicate tasks** | `task_search` tool lets AI check before creating. UI deduplicates by title similarity. |
| **Email extraction is too aggressive** | On/off per account. No aggression slider — AI uses conservative defaults. User can delete unwanted tasks. |
| **Tasks vs calendar confusion** | Clear visual distinction: tasks = list groups, calendar = time grid. No time slots on tasks. |
| **Completed tasks pile up** | Auto-archive completed tasks older than 30 days (background job). Or just paginate. |
| **Drag reorder conflicts with due date sort** | Drag reorder only within groups. Grouping still respects due date. Manual order is a secondary sort within the same due date bucket. |

## What Doesn't Change

- **Calendar** — unchanged (events, CalDAV, ICS)
- **Email** — unchanged (sync, classification, summarization) — only adds `taskScanned` flag
- **Memory** — unchanged (tasks are separate from memories)
- **Chat** — unchanged (adds task tools to available toolset)
- **Notifications** — unchanged (tasks use existing notification API)
- **Jobs** — unchanged (adds one new job type)
