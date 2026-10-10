"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/http";
import { splitEmailAddresses } from "@/lib/email/utils";

export interface RecipientSuggestion {
  name: string | null;
  email: string;
  source: "contact" | "recent";
}

interface RecipientInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  id?: string;
  className?: string;
}

const MAX_SUGGESTIONS = 8;
const CACHE_TTL = 60_000;

// Contact book + recent recipients are identical for every field of a sheet —
// one fetch per 60s, shared across To/Cc/Bcc instances.
let cache: { at: number; suggestions: RecipientSuggestion[] } | null = null;
let inFlight: Promise<RecipientSuggestion[]> | null = null;

function loadSuggestions(): Promise<RecipientSuggestion[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return Promise.resolve(cache.suggestions);
  if (!inFlight) {
    inFlight = (async () => {
      const [contacts, recent] = await Promise.all([
        fetchJson<{
          contacts: Array<{ name: string; email: string }>;
        }>("/api/contacts?limit=200"),
        fetchJson<{
          recipients: Array<{ name: string | null; email: string }>;
        }>("/api/contacts/recent?limit=25"),
      ]);
      const seen = new Set<string>();
      const suggestions: RecipientSuggestion[] = [];
      for (const contact of contacts.contacts) {
        const key = contact.email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ name: contact.name, email: contact.email, source: "contact" });
      }
      for (const r of recent.recipients) {
        const key = r.email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ name: r.name, email: r.email, source: "recent" });
      }
      cache = { at: Date.now(), suggestions };
      return suggestions;
    })().catch((err) => {
      console.error("Failed to load recipient suggestions:", err);
      return cache?.suggestions ?? [];
    });
    inFlight.finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** The segment the user is currently typing: the text after the last comma. */
function currentDraft(value: string): string {
  const idx = value.lastIndexOf(",");
  return (idx === -1 ? value : value.slice(idx + 1)).trim();
}

/** Everything before the current draft, including the trailing comma. */
function beforeDraft(value: string): string {
  const idx = value.lastIndexOf(",");
  return idx === -1 ? "" : value.slice(0, idx + 1).trimEnd();
}

/**
 * Recipient field with contact-book autocomplete.
 *
 * The value stays a plain comma-separated string (the form contract is
 * unchanged), so the send route and reply prefill keep working verbatim.
 * Typing a fragment filters contacts first, then "recent" recipients from the
 * Sent folders; picking one writes `Name <email>` and adds a `, ` so the next
 * recipient can be typed right away.
 */
export function RecipientInput({
  value,
  onChange,
  label,
  placeholder,
  id,
  className,
}: RecipientInputProps) {
  const [all, setAll] = useState<RecipientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The dropdown only makes sense while typing at the end of the field —
  // editing in the middle of a long list would clobber other entries.
  const caretAtEnd = useCallback(() => {
    const el = inputRef.current;
    if (!el) return false;
    return (el.selectionEnd ?? 0) >= el.value.length;
  }, []);

  const syncOpen = useCallback(() => {
    const draft = currentDraft(value);
    setOpen(draft.length > 0 && caretAtEnd());
    setHighlight(-1);
  }, [value, caretAtEnd]);

  // Fetch once per session when a field is first used.
  useEffect(() => {
    let cancelled = false;
    loadSuggestions().then((suggestions) => {
      if (!cancelled) setAll(suggestions);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!open) return [];
    const draft = currentDraft(value);
    if (!draft) return [];
    const query = draft.toLowerCase();
    const committed = new Set(
      splitEmailAddresses(beforeDraft(value)).map((entry) => {
        const match = entry.match(/<([^<>]+)>/);
        return (match?.[1] ?? entry).trim().toLowerCase();
      }),
    );
    const isEmailFragment = draft.includes("@") || query.includes(".");
    return all
      .filter((s) => {
        if (committed.has(s.email.toLowerCase())) return false;
        const emailHit = s.email.toLowerCase().includes(query);
        const nameHit = s.name?.toLowerCase().includes(query) ?? false;
        // A bare word matches names first; once it looks like an address,
        // emails must match.
        return isEmailFragment ? emailHit : nameHit || emailHit;
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [all, open, value]);

  const select = useCallback(
    (s: RecipientSuggestion) => {
      const entry = s.name ? `${s.name} <${s.email}>` : s.email;
      const before = beforeDraft(value);
      onChange(`${before ? `${before} ` : ""}${entry}, `);
      setOpen(false);
      setHighlight(-1);
    },
    [value, onChange],
  );

  const commitDraft = useCallback(() => {
    const draft = currentDraft(value);
    if (!draft) return;
    const before = beforeDraft(value);
    onChange(`${before ? `${before} ` : ""}${draft}, `);
    setOpen(false);
  }, [value, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (filtered.length === 0) return;
        e.preventDefault();
        setOpen(true);
        setHighlight((prev) => {
          const next =
            e.key === "ArrowDown"
              ? (prev + 1) % filtered.length
              : prev <= 0
                ? filtered.length - 1
                : prev - 1;
          return next;
        });
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (open && highlight >= 0 && filtered[highlight]) {
          e.preventDefault();
          select(filtered[highlight]);
        } else if (open && currentDraft(value)) {
          // Enter commits the half-typed recipient so the user can continue
          // with the next one — it does not submit the form.
          e.preventDefault();
          commitDraft();
        }
      } else if (e.key === "Escape") {
        setOpen(false);
        setHighlight(-1);
      } else if (e.key === "Backspace") {
        // Swallow a stray trailing separator so Backspace deletes whole entries.
        const draft = currentDraft(value);
        if (!draft && value !== value.replace(/,\s*$/, "")) {
          e.preventDefault();
          onChange(value.replace(/,\s*$/, ""));
        }
      }
    },
    [filtered, open, highlight, select, commitDraft, value, onChange],
  );

  // Keep the highlighted row visible.
  useEffect(() => {
    if (highlight < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div className="relative">
      <Input
        id={id}
        ref={inputRef}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          syncOpen();
        }}
        onKeyUp={syncOpen}
        onClick={syncOpen}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setOpen(false);
          setHighlight(-1);
        }}
        className={cn("font-mono", className)}
      />
      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="liquid-glass absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg p-1 shadow-2xl"
        >
          {filtered.map((s, i) => (
            <button
              key={`${s.source}-${s.email}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              data-index={i}
              onPointerDown={(e) => {
                e.preventDefault();
                select(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-100",
                i === highlight ? "bg-accent/70" : "hover:bg-accent/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name ?? s.email}</span>
                {s.name && (
                  <span className="text-muted-foreground block truncate font-mono text-xs">
                    {s.email}
                  </span>
                )}
              </span>
              <span className="console-label text-muted-foreground shrink-0">
                {s.source === "contact" ? "Contact" : "Recent"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
