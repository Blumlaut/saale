"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { fetchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PALETTE_LIMIT,
  PALETTE_KINDS,
  PALETTE_KIND_CHIP_LABELS,
  PALETTE_KIND_LABELS,
  type PaletteKind,
  type PaletteResult,
} from "@/lib/search/palette-result";

/** What the chips filter on: every kind, or the one that is on. */
type KindFilter = "all" | PaletteKind;

const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  ...PALETTE_KINDS.map((kind) => ({ value: kind, label: PALETTE_KIND_CHIP_LABELS[kind] })),
];

/** How many chats the box opens on, before anything is typed. */
const RECENT_LIMIT = 5;

/** Typing this long before asking, so a word is not searched letter by letter. */
const QUERY_DEBOUNCE_MS = 200;

/** The palette's promise, in one line, for the empty box. */
const EMPTY_HINT =
  "Type to search chats, mail, tasks, calendar, memories, automations and servers.";

/** A chat from `/api/chat/sessions`, cut down to what a row shows. */
interface RecentSession {
  id: string;
  title: string;
  messageCount: number;
  deleting: boolean;
}

function recentRows(sessions: readonly RecentSession[]): PaletteResult[] {
  // A chat that was opened and left empty is not somewhere to go back to.
  return sessions
    .filter((session) => !session.deleting && session.messageCount > 0)
    .slice(0, RECENT_LIMIT)
    .map((session) => ({
      kind: "chat",
      id: session.id,
      title: session.title,
      snippet: session.messageCount === 1 ? "1 message" : `${session.messageCount} messages`,
      score: 0,
      href: `/dashboard/chat/${session.id}`,
    }));
}

/** What the strip under the list says about the list. */
function footerText(trimmed: string, loading: boolean, count: number): string {
  if (loading) return "Searching…";
  // An empty box that knows no chats says nothing: the hint above already does.
  if (!trimmed) return count === 0 ? "" : "Recent chats";
  return count === 1 ? "1 result" : `${count} results`;
}

/**
 * The ⌘K box: one query over everything the agent can reach, with a chip per
 * kind so a search can be narrowed without retyping it.
 *
 * Opened from the sidebar's search row, from the phone's search button, and
 * from anywhere with ⌘K. Its state is per visit: it opens with an empty box and
 * the chats you were last in.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [results, setResults] = useState<PaletteResult[]>([]);
  const [recent, setRecent] = useState<PaletteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = query.trim();
  // Recent rows are chats, so only those two filters open on them.
  const rows = trimmed ? results : kind === "all" || kind === "chat" ? recent : [];

  // The recent chats the box opens on, read once per visit.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchJson<{ sessions: RecentSession[] }>("/api/chat/sessions", {
      signal: controller.signal,
    })
      .then((data) => setRecent(recentRows(data.sessions ?? [])))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to read the recent chats:", err);
      });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, limit: String(DEFAULT_PALETTE_LIMIT) });
      if (kind !== "all") params.set("type", kind);
      setLoading(true);
      fetchJson<{ results: PaletteResult[] }>(`/api/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then((data) => setResults(data.results ?? []))
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.error("The palette search failed:", err);
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, QUERY_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, kind]);

  // A new list starts at its best row, and that row stays in view as it moves.
  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed, kind]);

  useEffect(() => {
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows.length]);

  const openResult = useCallback(
    (result: PaletteResult) => {
      onOpenChange(false);
      router.push(result.href);
    },
    [onOpenChange, router],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length,
      );
      return;
    }
    if (event.key === "Enter") {
      const result = rows[activeIndex];
      if (!result) return;
      event.preventDefault();
      openResult(result);
    }
  };

  const footer = footerText(trimmed, loading, rows.length);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery("");
          setKind("all");
          setResults([]);
          setActiveIndex(0);
        }
      }}
    >
      {/* Anchored to the top: the list grows downward from the box, not around it. */}
      <DialogContent className="top-[8vh] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Search the workspace</DialogTitle>

        {/* pr-10 keeps the text clear of the dialog's own close button. */}
        <div className="border-border flex items-center gap-2 border-b pr-10 pl-3">
          <Search className="text-muted-foreground h-4 w-4 shrink-0" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search the workspace…"
            aria-label="Search the workspace"
            autoComplete="off"
            className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {loading && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
        </div>

        <div className="border-border border-b px-2 py-1.5">
          <SegmentedControl
            value={kind}
            options={KIND_FILTERS}
            onChange={setKind}
            label="Narrow the results to one kind"
            wrap
          />
        </div>

        <div
          role="listbox"
          aria-label="Results"
          className="max-h-[min(52vh,22rem)] min-h-0 overflow-y-auto p-1"
        >
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {trimmed && !loading ? "Nothing matched." : EMPTY_HINT}
            </p>
          ) : (
            rows.map((result, index) => (
              <div
                key={`${result.kind}:${result.id}`}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => openResult(result)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150",
                  index === activeIndex ? "bg-accent/70" : "hover:bg-accent/60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{result.title}</div>
                  <div className="text-muted-foreground truncate text-xs">{result.snippet}</div>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {PALETTE_KIND_LABELS[result.kind]}
                </Badge>
              </div>
            ))
          )}
        </div>

        <div className="text-muted-foreground border-border flex items-center justify-between gap-3 border-t px-3 py-2 text-xs">
          <span className="truncate">{footer}</span>
          <span className="text-muted-foreground/70 hidden shrink-0 sm:block">
            ↑↓ move · ↵ open
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
