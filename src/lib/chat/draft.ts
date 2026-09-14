/**
 * Composer drafts (per chat session) — kept in localStorage so a half-typed
 * message survives navigation, a reload, or a browser restart.
 *
 * Stored per session, so switching chats never drags a draft into the wrong
 * conversation, and shared across tabs (the `storage` event syncs them).
 * Attachments are not persisted: File objects cannot be serialized, and the
 * composer keeps them in memory only.
 */

const DRAFT_PREFIX = "saale:chat-draft:";

/** Cap on retained drafts — oldest entries are dropped past this. */
const MAX_DRAFTS = 50;
/** Mirror of the server-side message limit, so drafts cannot grow unbounded. */
const MAX_DRAFT_CHARS = 100_000;

interface StoredDraft {
  text: string;
  updatedAt: number;
}

export function draftStorageKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch (err) {
    // Storage can be unavailable (private mode, blocked cookies).
    console.error("Chat draft storage unavailable:", err);
    return null;
  }
}

export function loadDraft(sessionId: string): string {
  const store = storage();
  if (!store) return "";
  try {
    const raw = store.getItem(draftStorageKey(sessionId));
    if (!raw) return "";
    const parsed = JSON.parse(raw) as StoredDraft;
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch (err) {
    console.error("Failed to read chat draft:", err);
    return "";
  }
}

export function saveDraft(sessionId: string, text: string): void {
  const store = storage();
  if (!store) return;
  const key = draftStorageKey(sessionId);
  try {
    if (!text) {
      store.removeItem(key);
      return;
    }
    store.setItem(
      key,
      JSON.stringify({ text: text.slice(0, MAX_DRAFT_CHARS), updatedAt: Date.now() }),
    );
    pruneDrafts(store);
  } catch (err) {
    console.error("Failed to save chat draft:", err);
  }
}

export function clearDraft(sessionId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(draftStorageKey(sessionId));
  } catch (err) {
    console.error("Failed to clear chat draft:", err);
  }
}

/** Drop the least recently edited drafts once the cap is exceeded. */
function pruneDrafts(store: Storage): void {
  const entries: Array<{ key: string; updatedAt: number }> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    let updatedAt = 0;
    try {
      updatedAt = (JSON.parse(store.getItem(key) ?? "{}") as StoredDraft).updatedAt ?? 0;
    } catch (err) {
      console.error(`Malformed chat draft at ${key}:`, err);
    }
    entries.push({ key, updatedAt });
  }

  if (entries.length <= MAX_DRAFTS) return;
  entries
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, entries.length - MAX_DRAFTS)
    .forEach(({ key }) => {
      try {
        store.removeItem(key);
      } catch (err) {
        console.error(`Failed to prune chat draft ${key}:`, err);
      }
    });
}
