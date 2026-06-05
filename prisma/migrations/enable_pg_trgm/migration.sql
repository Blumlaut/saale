-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes for search
CREATE INDEX IF NOT EXISTS idx_chat_session_title_trgm ON "ChatSession" USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_email_subject_trgm ON "EmailMessage" USING gin (subject gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_email_body_preview_trgm ON "EmailMessage" USING gin ("bodyPreview" gin_trgm_ops);
