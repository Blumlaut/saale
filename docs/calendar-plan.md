# Calendar Feature — Design Plan

## Goal

Add a full-featured calendar to Saale: CalDAV sync, ICS import/export, local event creation, agent-aware read/write, email-to-calendar event extraction, and upcoming-event notifications.

## Library Choices

| Need | Library | Why |
|---|---|---|
| **CalDAV client** | `tsdav` (v2.2.2) | TypeScript-native, active (May 2026), supports Basic/OAuth/Bearer auth, works with Google/iCloud/Nextcloud/Fastmail/Baikal/DAViCal, has `smartCollectionSyncDetailed` for incremental sync |
| **ICS parsing** | `ical` (v0.8.0) | Minimal, tolerant iCalendar parser. Used for ICS file import and parsing raw VEVENT data from CalDAV responses |
| **ICS generation** | `ical-generator` (v10.2.0) | Well-maintained, generates valid .ics files for export/download |

## Prisma Schema

```prisma
// ─── Calendar ──────────────────────────────────────────────────

model CalendarAccount {
  id               String            @id @default(cuid())
  userId           String
  name             String            // User-friendly label (e.g. "Google Work", "iCloud Personal")
  serverUrl        String            // e.g. "https://caldav.icloud.com" or "https://apidata.googleusercontent.com/caldav/v2/"
  username         String
  encryptedPassword String           @db.Text  // App password or token secret
  authMethod       String            @default("basic") // "basic" | "oauth" | "bearer"
  // OAuth fields (nullable, used when authMethod = "oauth")
  tokenUrl         String?
  clientId         String?
  refreshToken     String?           @db.Text
  accessToken      String?           @db.Text
  accessTokenExpiresAt DateTime?
  enabled          Boolean           @default(true)
  lastSyncedAt     DateTime?
  calendars        Calendar[]
  user             User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt

  @@unique([userId, username, serverUrl])
  @@index([userId])
  @@map("CalendarAccount")
}

model Calendar {
  id               String         @id @default(cuid())
  accountId        String
  remoteId         String?        // Remote calendar identifier (URL or ID from CalDAV server)
  name             String         // Display name from server
  color            String?        // Calendar color (hex, from server or user override)
  description      String?        @db.Text
  readOnly         Boolean        @default(false)
  enabled          Boolean        @default(true)
  lastSyncedAt     DateTime?
  ctag             String?        // Calendar CTAG for sync detection
  syncToken        String?        // Sync-token for incremental sync (RFC 6638)
  events           CalendarEvent[]
  account          CalendarAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt

  @@unique([accountId, remoteId])
  @@index([accountId])
  @@map("Calendar")
}

model CalendarEvent {
  id               String     @id @default(cuid())
  calendarId       String
  uid              String     // iCalendar UID (unique across calendars)
  summary          String     @default("(no title)")
  description      String?    @db.Text
  location         String?
  url              String?
  status           String?    // "CONFIRMED" | "TENTATIVE" | "CANCELLED"
  transparency     String?    // "OPAQUE" | "TRANSPARENT" (free/busy)
  sequence         Int        @default(0) // iCalendar SEQUENCE for conflict detection

  // Dates
  dtStart          DateTime   // Start datetime (or all-day date)
  dtEnd            DateTime?  // End datetime (null for all-day, computed from duration)
  allDay           Boolean    @default(false)
  timeZone         String?    // Timezone identifier (e.g. "Europe/Berlin")

  // Recurrence
  recurrenceRule   String?    @db.Text // RRULE string
  recurrenceDateIds String[]  @default([]) // RDATE UIDs for expanded instances
  exceptionDateIds String[]   @default([]) // EXDATE UIDs

  // Alerts
  alerts          String?    @db.Text // JSON array of { triggerMinutes, action }

  // Origin tracking
  source           String     @default("manual") // "manual" | "caldav" | "email_extraction" | "ics_import"
  sourceEmailId    String?    // Link back to EmailMessage if created by email extraction

  // Sync metadata
  etag             String?    // Entity tag for change detection
  lastModified     DateTime?

  calendar         Calendar   @relation(fields: [calendarId], references: [id], onDelete: Cascade)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt

  @@unique([calendarId, uid])
  @@index([calendarId, dtStart])
  @@index([dtStart])
  @@map("CalendarEvent")
}
```

### Design Decisions

- **`CalendarAccount` mirrors `EmailAccount`** pattern: encrypted credentials, enabled/disabled, lastSyncedAt
- **`Calendar` (not `CalendarCalendar`) mirrors IMAP folders**: one account → multiple calendars, each with its own sync token
- **`CalendarEvent.uid` is the iCalendar UID**: globally unique per event, used for dedup across calendars
- **Recurrence stored as RRULE string**: we don't expand recurrences locally — the CalDAV server handles expansion. We store the raw RRULE and let the UI library handle display expansion
- **`sequence` field**: iCalendar SEQUENCE number for detecting server-side updates without full comparison
- **`syncToken` per calendar**: RFC 6638 sync-token for efficient incremental sync via `smartCollectionSyncDetailed`
- **`source` field on events**: tracks origin (`manual`, `caldav`, `email_extraction`, `ics_import`) for dedup and UI display
- **`sourceEmailId` on events**: links back to the source `EmailMessage` when created by email extraction
- **`calendarScanned` on `EmailMessage`**: new boolean field on the existing EmailMessage model — prevents the email-to-calendar job from re-processing the same email

## File Structure

```
src/
├── lib/
│   └── calendar/
│       ├── caldav.ts          # CalDAV client creation, auth, read + write-back helpers
│       ├── sync.ts            # Full + incremental sync logic (mirrors email/sync.ts)
│       ├── ics-import.ts      # Parse .ics file content → events
│       ├── ics-export.ts      # Generate .ics file for download
│       ├── recurrence.ts      # RRULE parsing helpers, date expansion
│       └── email-extraction.ts # AI job: scan emails → extract events → create calendar entries
├── app/
│   ├── api/
│   │   └── calendar/
│   │       ├── accounts/
│   │   │   ├── route.ts                    # GET/POST accounts
│   │   │   └── [accountId]/
│   │   │       ├── route.ts                # GET/PATCH/DELETE account
│   │   │       ├── sync/route.ts           # POST trigger sync
│   │   │       ├── test-connection/route.ts# POST test CalDAV connection
│   │   │       └── discover/route.ts       # POST discover calendars
│   │       ├── events/
│   │   │   ├── route.ts                    # GET events (date range filter)
│   │   │   └── [eventId]/route.ts          # GET/PATCH/DELETE event
│   │       └── export/route.ts             # GET export as .ics
│   │       └── import/route.ts             # POST import .ics file
│   └── dashboard/
│       └── calendar/
│           ├── page.tsx                    # Main calendar view
│           └── components/
│               ├── calendar-view.tsx        # Month/week/day view
│               ├── event-dialog.tsx         # Create/edit event modal
│               ├── event-card.tsx           # Event display in list/compact view
│               ├── calendar-list.tsx        # Sidebar calendar filters
│               ├── upcoming-events.tsx      # Upcoming events widget
│               └── account-dialog.tsx       # Add CalDAV account modal
├── components/
│   └── layout/
│       └── (dashboard-nav.tsx — add Calendar nav item)
├── lib/
│   ├── pi/
│   │   └── tools/
│   │       └── calendar-tools.ts  # Agent tools for calendar
│   └── queue/
│       └── (job-schemas.ts — add calendar_sync job type)
└── types/
    └── shared.ts  # Add CalendarAccount, Calendar, CalendarEvent types
```

## API Routes

### Accounts

| Method | Path | Description |
|---|---|---|
| GET | `/api/calendar/accounts` | List all CalDAV accounts with their calendars |
| POST | `/api/calendar/accounts` | Add new CalDAV account |
| GET | `/api/calendar/accounts/:id` | Get account details |
| PATCH | `/api/calendar/accounts/:id` | Update account (enable/disable, rename) |
| DELETE | `/api/calendar/accounts/:id` | Remove account and all synced data |
| POST | `/api/calendar/accounts/:id/sync` | Trigger immediate sync |
| POST | `/api/calendar/accounts/:id/test-connection` | Test CalDAV credentials |
| POST | `/api/calendar/accounts/:id/discover` | Discover remote calendars |

### Events

| Method | Path | Description |
|---|---|---|
| GET | `/api/calendar/events?from=...&to=...&calendarIds=...` | Fetch events in date range |
| GET | `/api/calendar/events/:id` | Get single event |
| PATCH | `/api/calendar/events/:id` | Update event (local only, not pushed to CalDAV) |
| DELETE | `/api/calendar/events/:id` | Delete local event |

### Import/Export

| Method | Path | Description |
|---|---|---|
| GET | `/api/calendar/export?from=...&to=...&format=ics` | Export events as .ics download |
| POST | `/api/calendar/import` | Import .ics file (multipart), events stored locally |

## Sync Logic (`lib/calendar/sync.ts`)

Mirrors the email sync pattern:

### Full Sync
1. Connect to CalDAV via `tsdav`
2. `fetchCalendars()` → upsert `Calendar` records
3. For each calendar: `fetchCalendarObjects({ calendar, dateFrom, dateTo })` 
4. Parse each VCALENDAR/VEVENT with `ical`
5. Upsert `CalendarEvent` records by `[calendarId, uid]`
6. Update `lastSyncedAt`, `ctag`, `syncToken`

### Incremental Sync (preferred)
1. Connect to CalDAV via `tsdav`
2. For each calendar with a `syncToken`:
   - `smartCollectionSyncDetailed({ collection: { url, syncToken, ... } })` 
   - Returns `{ created, updated, deleted }` URLs
3. Fetch changed objects, parse, upsert/delete locally
4. Update `syncToken` per calendar

### Error Handling
- Best-effort per calendar (one failing calendar doesn't block others)
- Retry with exponential backoff on transient errors
- Store sync errors in notifications

## CalDAV Client (`lib/calendar/caldav.ts`)

```typescript
// Pattern mirrors lib/email/imap.ts

export async function connectCalDAV(accountId: string): Promise<{
  client: DAVClient;
  account: CalendarAccount;
}> {
  const account = await prisma.calendarAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Calendar account ${accountId} not found`);

  const password = account.authMethod === 'basic' 
    ? decrypt(account.encryptedPassword) 
    : null;

  const client = new DAVClient({
    serverUrl: account.serverUrl,
    credentials: account.authMethod === 'basic'
      ? { username: account.username, password! }
      : { accessToken: account.accessToken },
    authMethod: account.authMethod === 'basic' ? 'Basic' : 'Bearer',
    defaultAccountType: 'caldav',
  });

  await client.login();
  return { client, account };
}
```

### Provider Presets

Common CalDAV endpoints for the "Add Account" dialog:

| Provider | Server URL | Auth |
|---|---|---|
| **iCloud** | `https://caldav.icloud.com` | Basic (Apple ID + app-specific password) |
| **Google** | `https://apidata.googleusercontent.com/caldav/v2/` | OAuth2 (requires token exchange) |
| **Nextcloud** | `https://{host}/remote.php/dav/calendars/{user}/` | Basic or Bearer |
| **Fastmail** | `https://caldav.fastmail.com` | Basic |
| **Baikal** | `https://{host}/dav.php/calendars/{user}/` | Basic |
| **DAViCal** | `https://{host}/caldav.php/{user}/` | Basic |
| **Custom** | User-provided | Basic |

For MVP, support **Basic auth** only (covers iCloud, Fastmail, Nextcloud app passwords, Baikal, DAViCal, self-hosted). OAuth can be added later for Google.

## UI Components

### Calendar View (`calendar-view.tsx`)

Three views, tab-switched:
- **Month**: Grid view, one cell per day, event dots/truncation
- **Week**: Time-grid view (6am–10pm), events as colored blocks
- **Day**: Single day time-grid

We'll use a lightweight custom implementation (no heavy calendar library like FullCalendar). The glass-panel design system fits well with a clean grid.

Key features:
- Drag to create new events (date range selection)
- Click event → open event dialog
- Sidebar: calendar list with checkboxes and color dots
- Date navigation: prev/next + today button

### Event Dialog (`event-dialog.tsx`)

Create/edit modal with fields:
- Title (required)
- Date/time (start + end, all-day toggle)
- Timezone
- Location
- Description (textarea)
- Calendar selector (which calendar to save to)
- Status (confirmed/tentative/cancelled)
- Recurrence (none/daily/weekly/monthly/yearly — simplified RRULE)
- Alerts (15min before, 1hour before, day of)

### Upcoming Events Widget (`upcoming-events.tsx`)

Small widget showing next 5 events with:
- Relative time ("in 30 min", "tomorrow at 2pm")
- Calendar color indicator
- Click to navigate to event

Used in dashboard home or as a collapsible sidebar panel.

### Account Dialog (`account-dialog.tsx`)

Mirrors the email account dialog:
- Provider preset selector (iCloud, Nextcloud, Fastmail, Custom)
- Server URL (auto-filled for presets)
- Username + password fields
- Account name (user-friendly label)
- Test connection button
- On success → discover calendars → enable sync

## Agent Tools (`lib/pi/tools/calendar-tools.ts`)

The agent gets full read/write access to the calendar. Tools follow the same pattern as `job-tools.ts` with userId scoping.

### Read Tools

| Tool | Purpose |
|---|---|
| `calendar_list` | List calendars with event counts |
| `calendar_search` | Search events by query (title, description, location) |
| `calendar_upcoming` | Get upcoming events (next N hours/days) |
| `calendar_get` | Get a single event by ID |

### Write Tools

| Tool | Purpose |
|---|---|
| `calendar_create` | Create a new event — stored locally **and pushed to CalDAV** if the target calendar is a synced CalDAV calendar |
| `calendar_update` | Update an existing event — local + push to CalDAV if applicable |
| `calendar_delete` | Delete an event — local + push DELETE to CalDAV if applicable |

### CalDAV Write-Back (`lib/calendar/caldav.ts`)

Helper functions for pushing local changes to CalDAV:

```typescript
// Push a new event to CalDAV
export async function pushEventToCalDAV(
  calendarId: string,
  event: CalendarEvent,
): Promise<{ success: boolean; remoteUid?: string; etag?: string; error?: string }>;

// Push an updated event to CalDAV
export async function pushUpdateToCalDAV(
  calendarId: string,
  event: CalendarEvent,
): Promise<{ success: boolean; etag?: string; error?: string }>;

// Delete an event from CalDAV
export async function pushDeleteToCalDAV(
  calendarId: string,
  event: CalendarEvent,
): Promise<{ success: boolean; error?: string }>;
```

Each function:
1. Generates a valid VCALENDAR/VEVENT string via `ical-generator`
2. Calls `tsdav` `saveCalendarObject()` / `deleteCalendarObject()`
3. Stores the returned `etag` and remote `uid` back to the local record
4. On failure, keeps the local change and sends a `calendar_sync_error` notification

This means the agent can be told "add a dentist appointment next Tuesday at 3pm" and it appears both locally and on the synced CalDAV server.

### Example Agent Conversations

```
User: "What's on my schedule this week?"
Agent → calendar_upcoming(days: 7) → formatted response

User: "Add a team standup every Monday at 9am, starting next week"
Agent → calendar_create(title: "Team Standup", dtStart: ..., recurrenceRule: "FREQ=WEEKLY;BYDAY=MO")
       → pushes to CalDAV

User: "Move my 2pm meeting to 3pm"
Agent → calendar_upcoming(hours: 1) → finds event → calendar_update → pushes to CalDAV
```

## Sync Job Types (`lib/queue/job-schemas.ts`)

Add two job types to `jobTypeSchemas`:

### 1. Calendar Sync (pull from CalDAV)

```typescript
{
  type: "calendar_sync",
  label: "Calendar Sync",
  description: "Sync events from connected CalDAV accounts",
  icon: "Calendar",
  defaultCron: "*/15 * * * *",
  usesAi: false,
  fields: [
    {
      key: "accountId",
      label: "Account",
      description: "Leave empty to sync all enabled accounts",
      type: "select",
      default: "",
      options: [], // populated at runtime
    },
  ],
}
```

### 2. Email-to-Calendar Extraction (AI-powered)

```typescript
{
  type: "email_to_calendar",
  label: "Email → Calendar",
  description: "Scan emails for appointment-like content and create calendar events",
  icon: "CalendarPlus",
  defaultCron: "0 */4 * * *",
  usesAi: true,
  fields: [
    {
      key: "accountId",
      label: "Email Account",
      description: "Leave empty to scan all enabled email accounts",
      type: "select",
      default: "",
      options: [], // populated at runtime from email accounts
    },
    {
      key: "targetCalendarId",
      label: "Target Calendar",
      description: "Calendar to create events in (leave empty for default calendar)",
      type: "select",
      default: "",
      options: [], // populated at runtime from calendar accounts
    },
    {
      key: "limit",
      label: "Batch size",
      description: "Number of emails to scan per run",
      type: "number",
      default: 20,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: "maxEmailAge",
      label: "Max email age",
      description: "Only scan emails received within this many hours (0 = no limit)",
      type: "number",
      default: 48,
      min: 0,
      max: 720,
      step: 1,
    },
    {
      key: "modelId",
      label: "AI Model",
      description: "Model used for event extraction",
      type: "model",
      default: "",
    },
  ],
}
```

## Settings Tab

Add a "Calendar" tab to `/dashboard/settings` (alongside Email, Providers, etc.):
- List of CalDAV accounts (similar to EmailTab pattern)
- Enable/disable per account
- Sync now / full refresh / delete actions
- Per-calendar visibility toggles
- Add account button

## Notifications Integration

When sync finds upcoming events (within notification window):
- Push to existing Redis notification system
- Type: `calendar_reminder`
- Title: Event summary
- Message: "in {relative time}"

When email-to-calendar creates events:
- Type: `calendar_event_created`
- Title: "Event extracted from email"
- Message: "{summary} — {date}"

When CalDAV write-back fails:
- Type: `calendar_sync_error`
- Title: "Calendar update failed"
- Message: Error details

## Implementation Order

### Step 1: Database + Dependencies
- Add Prisma models → `prisma migrate dev`
- Install `tsdav`, `ical`, `ics`
- Add `calendar_sync` job type to job-schemas

### Step 2: Core Library
- `lib/calendar/caldav.ts` — client creation, auth
- `lib/calendar/sync.ts` — full + incremental sync
- `lib/calendar/ics-import.ts` — ICS parsing
- `lib/calendar/ics-export.ts` — ICS generation

### Step 3: API Routes
- Calendar accounts CRUD + sync + test-connection + discover
- Calendar events CRUD + date range queries
- Import/export endpoints

### Step 4: Sync Job Handlers
- Add `calendar_sync` case to `lib/queue/job-handler.ts` (CalDAV pull sync)
- Add `email_to_calendar` case to `lib/queue/job-handler.ts` (AI event extraction)
- Wire into BullMQ worker

### Step 5: Agent Tools (Read + Write)
- `lib/pi/tools/calendar-tools.ts` — full read/write toolset
- CalDAV write-back in `lib/calendar/caldav.ts` (`pushEventToCalDAV`, `pushUpdateToCalDAV`, `pushDeleteToCalDAV`)
- Register tools in session creation

### Step 6: UI — Settings Tab
- Calendar settings tab (account management)
- Account dialog (add CalDAV account)

### Step 7: UI — Calendar Page
- Calendar view component (month/week/day)
- Event dialog (create/edit)
- Calendar list sidebar
- Upcoming events widget

### Step 8: UI — Nav Integration
- Add Calendar to dashboard nav
- Wire up keyboard shortcuts

### Step 9: Polish
- Tests (sync logic, ICS parsing, API routes)
- Error boundaries
- Mobile responsiveness
- Notification integration

## Email-to-Calendar Extraction (AI Job)

A BullMQ job that runs periodically and scans recent emails for appointment-like content.

### How It Works

1. **Fetch candidate emails**: Unprocessed emails from the last N hours (configurable `maxEmailAge`), filtered by `classified` status or a new `calendarScanned` flag
2. **AI extraction prompt**: For each email, send the subject + body preview to an LLM with a structured prompt asking it to extract event data:
   ```
   Does this email describe a scheduled event, appointment, meeting, or deadline?
   If yes, extract: title, start_date, start_time, end_date, end_time, location, description.
   If no, return null.
   ```
3. **Validation**: The extracted data is validated (dates must be parseable, end > start, etc.)
4. **Dedup check**: Before creating, check if an event with the same title + date range already exists (fuzzy match on title + exact match on start time)
5. **Create event**: If valid and not a duplicate, create a `CalendarEvent` in the target calendar
6. **Push to CalDAV**: If the target calendar is CalDAV-synced, push the new event to the remote server
7. **Mark email**: Set a flag on the email so it's not re-processed

### What Gets Detected

- Meeting invitations ("Let's meet on Tuesday at 3pm")
- Appointment confirmations ("Your appointment is confirmed for June 15 at 10:00 AM")
- Deadline reminders ("Submission due by Friday EOD")
- Flight/hotel bookings ("Your flight departs at 8:30 AM on July 3")
- Recurring events ("Every Monday at 9am starting next week")

### What Gets Skipped

- Generic newsletters
- Promotional emails
- Emails without clear date/time references
- Already-processed emails

### Prompt Design

The extraction prompt uses a structured JSON output schema (via Pi's tool calling or structured output) to ensure parseable results. The model is asked to be conservative — only extract when confident about both the event nature and the date/time.
