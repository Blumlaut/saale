-- Indexes for the search matcher in src/lib/search. Every expression here has to
-- stay identical to the one in `sources.ts`, or postgres will not use it.
--
-- The trigram indexes serve both `ILIKE '%term%'` (a fragment of a word) and the
-- `%>` operator (a misspelling). The full-text ones serve the prefix tsquery.
-- Without them every search is a sequential scan that recomputes to_tsvector for
-- each row.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Email ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "EmailMessage_subject_trgm_idx"
  ON "EmailMessage" USING gin (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EmailMessage_fromName_trgm_idx"
  ON "EmailMessage" USING gin ("fromName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EmailMessage_fromEmail_trgm_idx"
  ON "EmailMessage" USING gin ("fromEmail" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EmailMessage_body_trgm_idx"
  ON "EmailMessage" USING gin ((coalesce("bodyText", "bodyPreview")) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EmailMessage_search_fts_idx"
  ON "EmailMessage" USING gin ((
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce("fromName", '') || ' ' ||
      coalesce("fromEmail", '') || ' ' ||
      coalesce("bodyText", "bodyPreview", '')
    ), 'B')
  ));

-- ─── Chat ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ChatSession_title_trgm_idx"
  ON "ChatSession" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ChatSession_search_fts_idx"
  ON "ChatSession" USING gin ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
  ));

CREATE INDEX IF NOT EXISTS "ChatMessage_content_trgm_idx"
  ON "ChatMessage" USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ChatMessage_search_fts_idx"
  ON "ChatMessage" USING gin ((
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ));

-- ─── Contacts ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Contact_name_trgm_idx"
  ON "Contact" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_email_trgm_idx"
  ON "Contact" USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_company_trgm_idx"
  ON "Contact" USING gin (company gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_search_fts_idx"
  ON "Contact" USING gin ((
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(email, '') || ' ' || coalesce(company, '')
    ), 'B')
  ));

-- ─── Calendar ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "CalendarEvent_summary_trgm_idx"
  ON "CalendarEvent" USING gin (summary gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CalendarEvent_location_trgm_idx"
  ON "CalendarEvent" USING gin (location gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CalendarEvent_description_trgm_idx"
  ON "CalendarEvent" USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CalendarEvent_search_fts_idx"
  ON "CalendarEvent" USING gin ((
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(location, '') || ' ' || coalesce(description, '')
    ), 'B')
  ));

-- ─── Memory ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Memory_title_trgm_idx"
  ON "Memory" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Memory_content_trgm_idx"
  ON "Memory" USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Memory_search_fts_idx"
  ON "Memory" USING gin ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ));

-- ─── Tasks ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Task_title_trgm_idx"
  ON "Task" USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Task_description_trgm_idx"
  ON "Task" USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Task_search_fts_idx"
  ON "Task" USING gin ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ));
