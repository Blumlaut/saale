# Search

Every place Saale looks something up, and how a query is matched. All of it runs
through one matcher in `src/lib/search/`, so a half-remembered word behaves the
same in mail, chat, tasks, contacts, calendar and memory.

## Surfaces

### Agent tools

| Tool              | Where                            | Matches                              | Rows |
| ----------------- | -------------------------------- | ------------------------------------ | ---- |
| `mail_search`     | `lib/pi/tools/mail-tools.ts`     | subject, sender, body                | 20   |
| `chat_search`     | `lib/pi/tools/chat-tools.ts`     | message content, chat title          | 20   |
| `contacts_search` | `lib/pi/tools/contact-tools.ts`  | name, email, company                 | 20   |
| `calendar_search` | `lib/pi/tools/calendar-tools.ts` | title, location, description         | 20   |
| `memory_search`   | `lib/pi/tools/memory-tools.ts`   | title, content                       | 10   |
| `task_search`     | `lib/pi/tools/task-tools.ts`     | title, description                   | 100  |
| `web_search`      | `lib/pi/tools/web-tools.ts`      | SearXNG, which does its own matching | -    |

### HTTP routes

| Route                             | Matches                                               |
| --------------------------------- | ----------------------------------------------------- |
| `GET /api/search`                 | chat titles, chat messages, email subject/sender/body |
| `GET /api/email/messages?search=` | email subject, sender, body                           |
| `GET /api/contacts?search=`       | name, email, company                                  |
| `GET /api/memories?search=`       | title, content                                        |

### UI

| Surface                                                         | Reaches                               |
| --------------------------------------------------------------- | ------------------------------------- |
| ⌘K palette (`dashboard-nav`)                                    | `GET /api/search`                     |
| Mail inbox search box                                           | `GET /api/email/messages?search=`     |
| Contacts page                                                   | `includes()` over the fetched list    |
| Settings → memories                                             | `GET /api/memories?search=`           |
| Command sheet, model picker, every `PickerShell`/`SearchSelect` | `filterOptions()`, substring          |
| Admin → users                                                   | better-auth `searchValue`, email only |

No search at all: the chat session list, the files browser, jobs, automations,
the calendar page, and coder sessions.

## How a query is matched

A query splits into terms (`terms.ts`). Every term has to appear somewhere in the
row, so each word you add narrows the result. Each term then matches through up
to three arms, which cover different ways a word is half-remembered:

| Arm       | Predicate                     | Catches                           | Index                |
| --------- | ----------------------------- | --------------------------------- | -------------------- |
| substring | `col ILIKE '%term%'`          | a fragment of a word (`invoic`)   | GIN trigram          |
| full text | `tsvector @@ to_tsquery(...)` | word forms (`invoices`, `invoic`) | GIN on `to_tsvector` |
| trigram   | `col %> term`                 | a misspelling (`invoce`)          | GIN trigram          |

Rows come back ordered by relevance (`query.ts`): the full-text rank scaled by
eight, plus the best column weight times the best arm, summed over the terms.
Weights put a subject hit at three times a body hit, so an exact word in a
subject always outranks the same word buried in text.

### Where the fuzzy arm stops

The trigram arm only applies to terms of five characters or more. Short terms
have too few trigrams to tell apart: `similarity('car', 'card')` is 0.75.

It fires at a word similarity of 0.4, set with `set_config` inside the query's
transaction so the pooled connection is left alone. Measured on realistic
subjects, misspellings land between 0.45 and 0.7 while unrelated words stay at or
below 0.33:

| Typo           | Best true match | Best false positive |
| -------------- | --------------- | ------------------- |
| `invoce`       | 0.57            | 0.08                |
| `subscritpion` | 0.54            | 0.11                |
| `paymnet`      | 0.50            | 0.33                |
| `meating`      | 0.46            | 0.14                |
| `dentst`       | 0.57            | 0.13                |
| `fridy`        | 0.67            | 0.22                |

Trigrams measure shared three-character runs, so a swap of two letters is not a
near miss to them: `serach` scores 0.27 against `search`, and `reciept` 0.27
against `receipt`. A swapped or heavily mangled word still has to be spelled
properly, or found by its fragment.

### Indexes

`prisma/migrations/20261111120000_add_search_indexes` adds a GIN trigram index
per searched text column plus an expression index per weighted tsvector. The
expressions in `sources.ts` have to stay byte for byte what the migration
declares, or postgres quietly falls back to a sequential scan. On 50k rows:

| Query                                                          | Plan              | Time    |
| -------------------------------------------------------------- | ----------------- | ------- |
| `subject %> 'invoic'` (GIN trigram)                            | Bitmap Index Scan | 31 ms   |
| `subject ILIKE '%invoic%'` (GIN trigram)                       | Bitmap Index Scan | 15 ms   |
| `to_tsvector('english', subject \|\| body) @@ to_tsquery(...)` | Seq Scan          | 1345 ms |

The trigram indexes that `20260614141703_add_tasks` dropped are part of this
migration too.

### Keeping the result list short

Three things stop a search from burying the reader:

- Every term must match, so adding a word narrows.
- Relevance ordering, so the caller's cap keeps the best rows and not the newest.
- A cap per source: 20 rows for mail, chat, contacts and calendar, 10 for memory,
  25 for task search. The unfiltered task listing still returns everything.

`chat_search` also keeps at most three lines from any one chat, so a single busy
conversation cannot fill the page.

A result carries an excerpt centred on the matched words (`lib/search/snippet.ts`),
not the head of the text. Mail previews, chat lines and palette results all use
it, so the reader sees why the row matched without asking for more rows.

## What no longer goes wrong

- ⌘K matches inside chat messages, not only chat titles.
- Email body matches exist. Whole-string trigram similarity scored a 500-character
  preview 0.09 against a one-word query, so the old predicate never fired.
- A keyword in a normal subject line matches: `"invoice"` against
  `Receipt for your March invoice #4821` scored 0.222 under the old whole-string
  comparison, below the 0.3 threshold.
- Results are ordered by relevance, so the caller's `limit` keeps the best rows
  instead of the newest ones.
- `"invoice march"` means both words, where `mail_search` used to return every
  email holding either.
- Multi-word queries are stemmed and prefix-matched, so one misspelling no longer
  empties the result.
- `GET /api/memories?search=` searches in SQL. It used to filter in JavaScript
  after paging, which hid rows past the first page and reported an unfiltered
  total.
- `calendar_search` honours its `limit`, and orders by relevance instead of
  oldest first.
- `task_search` builds its predicate correctly. It read
  `trimmedQuery?.length ?? 0 > 0`, which evaluates as `number ?? boolean`.
- An empty query returns nothing. Every tool reports zero rows rather than the
  latest twenty of anything.
- ⌘K email results open the message, not just the mailbox.

## Where it lives

| File                    | Role                                                      |
| ----------------------- | --------------------------------------------------------- |
| `lib/search/terms.ts`   | term splitting, sanitising, the trigram gate              |
| `lib/search/query.ts`   | SQL predicate, score, execution, count                    |
| `lib/search/sources.ts` | one table per searchable model: fields, weights, tsvector |

A new searchable table is a spec in `sources.ts` plus its indexes in a migration.
