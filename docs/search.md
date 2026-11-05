# Search

Every place Saale looks something up, what it matches, and how well it tolerates a
half-remembered query. The short version: there are three different mechanisms in
use, none of them rank well, and only one of them is fuzzy at all.

## Surfaces

### Agent tools

| Tool              | Where                                            | Mechanism                        | Fields                                              | Ranked      | Typos  |
| ----------------- | ------------------------------------------------ | -------------------------------- | --------------------------------------------------- | ----------- | ------ |
| `chat_search`     | `lib/pi/tools/chat-tools.ts`                     | FTS `plainto_tsquery('english')` | `ChatMessage.content`                               | `ts_rank`   | no     |
| `mail_search`     | `lib/pi/tools/mail-tools.ts`                     | ILIKE per term, OR'd together    | subject, bodyText, bodyPreview, fromEmail, fromName | date desc   | no     |
| `contacts_search` | `lib/pi/tools/contact-tools.ts` → `listContacts` | ILIKE                            | name, email, company                                | name asc    | no     |
| `calendar_search` | `lib/pi/tools/calendar-tools.ts`                 | ILIKE                            | summary, description, location                      | dtStart asc | no     |
| `memory_search`   | `lib/pi/tools/memory-tools.ts`                   | FTS, ILIKE on error              | title, content                                      | `ts_rank`   | no     |
| `task_search`     | `lib/pi/tools/task-tools.ts`                     | FTS                              | title, description                                  | `ts_rank`   | no     |
| `web_search`      | `lib/pi/tools/web-tools.ts`                      | SearXNG                          | out of scope                                        | engine      | engine |

### HTTP routes

| Route                             | Mechanism                                   | Fields                                                            | Ranked         | Typos              |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- | -------------- | ------------------ |
| `GET /api/search`                 | pg_trgm `similarity()` + `%`, threshold 0.3 | `ChatSession.title`, email subject/fromName/fromEmail/bodyPreview | weighted score | short strings only |
| `GET /api/email/messages?search=` | ILIKE                                       | subject, fromEmail, fromName                                      | no             | no                 |
| `GET /api/contacts?search=`       | ILIKE via `listContacts`                    | name, email, company                                              | no             | no                 |
| `GET /api/memories?search=`       | JavaScript `includes()` after paging        | title, content, tags                                              | no             | no                 |

### UI

| Surface                                                         | Reaches                               |
| --------------------------------------------------------------- | ------------------------------------- |
| ⌘K palette (`dashboard-nav`)                                    | `GET /api/search`, 300 ms debounce    |
| Mail inbox search box                                           | `GET /api/email/messages?search=`     |
| Contacts page                                                   | `includes()` over the fetched list    |
| Settings → memories                                             | `GET /api/memories?search=`           |
| Command sheet, model picker, every `PickerShell`/`SearchSelect` | `filterOptions()`, substring          |
| Admin → users                                                   | better-auth `searchValue`, email only |

No search at all: the chat session list, the files browser, jobs, automations,
the calendar page, and coder sessions.

## What is wrong

### Whole-string trigram similarity barely matches anything

`GET /api/search` compares the query against the entire stored string. pg_trgm
scores short strings that share little length poorly, so a keyword in a normal
subject line lands under the default 0.3 threshold and is dropped. Measured on a
realistic set of subjects:

| Stored string                          | Query     | `similarity()` | Matched |
| -------------------------------------- | --------- | -------------- | ------- |
| `Receipt for your March invoice #4821` | `invoice` | 0.222          | no      |
| `Receipt for your March invoice #4821` | `reciept` | 0.100          | no      |
| `Weekly digest: 12 new pull requests`  | `invoice` | 0.000          | no      |
| `invoice`                              | `invoice` | 1.000          | yes     |

The same comparison on email bodies is hopeless by construction: a 500-character
`bodyPreview` against a one-word query scores 0.09. Bodies are in the `OR`, and
they never match. Chat is worse: only `ChatSession.title` is searched, so ⌘K
cannot find anything said inside a conversation.

### Full-text search is stemmed but exact about spelling

`chat_search`, `task_search` and `memory_search` use `plainto_tsquery`, which
handles plurals and word forms and fails on any typo:

```
plainto_tsquery('english', 'reciept')  → 'reciept'   -- never hits "receipt"
plainto_tsquery('english', 'invoice')  → 'invoic'    -- hits "invoice", "invoices"
```

Multiple words are AND'd, so one misspelled word in a three-word query returns
nothing. A query made only of stop words produces an empty tsquery and matches
nothing at all.

### ILIKE is a substring test, and the results are not ranked

`mail_search`, `contacts_search` and `calendar_search` do
`contains(term)` per column. `"invoic"` finds `"invoice"` and `"reciept"` finds
nothing. Ordering is not relevance at all:

- `mail_search` sorts by date descending, so the best match can sit past `limit`.
  Terms are OR'd, so `"invoice march"` returns every email holding either word,
  newest first. That is the context-blowup direction.
- `calendar_search` sorts by start date ascending with a hard `take: 20`, so old
  events win over upcoming ones.
- `contacts_search` sorts by name ascending with no scoring.

### The queries are not indexed

The trigram indexes from `20260613000000_enable_pg_trgm` were dropped by
`20260614141703_add_tasks` and never restored; only `ChatSession.title` had one
anyway. The full-text tools compute `to_tsvector()` per row. On 50k rows:

| Query                                 | Plan              | Time                      |
| ------------------------------------- | ----------------- | ------------------------- |
| `subject %> 'invoic'` (GIN trgm)      | Bitmap Index Scan | 31 ms                     |
| `subject ILIKE '%invoic%'` (GIN trgm) | Bitmap Index Scan | 15 ms                     |
| `to_tsvector('english', subject       |                   | body) @@ to_tsquery(...)` | Seq Scan | 1345 ms |

Every ⌘K keystroke pause runs two unindexed scans, and every `chat_search`
scans the whole message table. That is why the fuzzy path stays expensive.

### Bugs found while mapping

- `GET /api/memories?search=` filters in JavaScript after `take: limit`, so rows
  past the page are invisible and `total` counts unfiltered rows.
- `calendar_search` declares a `limit` parameter and ignores it (`queryEvents`
  hardcodes `take: 20`).
- `task_search` computes `hasQuery` as `trimmedQuery?.length ?? 0 > 0`, which
  evaluates as `number ?? boolean`. It works by accident.
- ⌘K email results navigate to `/dashboard/mail` without the message id.

## Making it fuzzier without the noise

Two arms per term, scored together. Precision comes from the first arm, tolerance
from the second.

**Arm 1, prefix FTS.** `to_tsquery` with `:*` on each term, AND'd. This is what
makes partial typing work, and it produces no noise because it is still lexeme
exact:

| Query                | Hits                                       |
| -------------------- | ------------------------------------------ |
| `spotif:*`           | `Your Spotify subscription payment failed` |
| `invoic:*`           | `Receipt for your March invoice #4821`     |
| `pull:* & request:*` | `Weekly digest: 12 new pull requests`      |

**Arm 2, word-level trigram, gated by term length.** `%`/`word_similarity` over
the whole text, or `max(similarity(term, word))` over split words, with a floor
that depends on length. Measured, per row of a six-message corpus:

| Typo'd query   | Best true match | Highest false positive |
| -------------- | --------------- | ---------------------- |
| `invoce`       | 0.50            | 0.08                   |
| `subscritpion` | 0.53            | 0.11                   |
| `meating`      | 0.45            | 0.14                   |
| `fridy`        | 0.44            | 0.22                   |
| `reciept`      | 0.33            | 0.22                   |
| `luch`         | 0.38            | 0.10                   |
| `paymnet`      | 0.33            | 0.33                   |

True typos sit between 0.33 and 0.53 while unrelated words stay at or below 0.22,
except for the `paymnet`/`Receipt` pair at 0.33. A floor of 0.4 is quiet and
catches three of the six typos. A floor of 0.3 catches five and starts pulling
`paymnet` → `Receipt`.

The gate matters more than the floor: short terms are trigram noise.
`similarity('car', 'card')` is 0.75, and `word_similarity('met', 'Tuesday')` is
0.20 but `word_similarity('car', 'card')` is 0.75. Terms of three characters or
fewer should use substring matching only.

Suggested floors:

| Term length | Fuzzy floor          |
| ----------- | -------------------- |
| 1-3         | none, substring only |
| 4           | 0.6                  |
| 5+          | 0.4                  |

**Score and rank.** `score = fts_hit ? 1 : 0` plus the arm 2 similarity, weighted
per column, so an exact lexeme always outranks a fuzzy neighbour. Order by score
and let `limit` fall where it lands.

**AND across terms.** Require every term to match somewhere in the row. A query
of `"invoice march"` should mean both words, which is the opposite of today's
`mail_search`. Keep an option for a single-term OR only where a user is expected
to type alternatives.

**Fewer results, clearer reason.** A soft floor on the final score and a hard cap
per source, so a typo'd query returns two good rows instead of forty mediocre
ones. Each result should carry the matched field so the agent can tell a subject
hit from a body hit.

**Indexes.** One migration adding GIN trigram indexes on the searched text
columns (chat title, email subject/bodyPreview/fromName/fromEmail, contact
name/email/company, calendar summary/description/location, memory title/content)
and expression GIN indexes on `to_tsvector('english', …)` for chat messages,
tasks and memories. Search then costs milliseconds instead of seconds.

**One matcher.** The per-term splitting, the floors and the scoring rules belong
in `src/lib/search/`, with each tool passing the columns it cares about. Today
`listContacts` and `contacts_search` are the same code, and the two memory paths
have diverged.

## Order of work

1. `src/lib/search/`: term splitting, the two arms, the floors, a score builder.
2. The index migration, including the trigram indexes that `add_tasks` dropped.
3. Move the ILIKE tools onto the matcher: `mail_search`, `contacts_search`,
   `calendar_search`.
4. Move the FTS tools onto it: `chat_search`, `memory_search`, `task_search`.
5. `GET /api/search`: search chat message content, use the matcher, return the
   matched field.
6. Fix the `/api/memories` paging bug and `calendar_search`'s ignored `limit`.
