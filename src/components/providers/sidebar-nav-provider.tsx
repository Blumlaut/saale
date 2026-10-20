"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchJson, patchJson } from "@/lib/http";
import {
  defaultSidebarNav,
  normalizeSidebarNav,
  visibleSidebarNavItems,
  type SidebarNavEntry,
  type SidebarNavItem,
} from "@/lib/navigation/sidebar-nav";

const SIDEBAR_NAV_URL = "/api/settings/sidebar-nav";

interface SidebarNavContextValue {
  /** Every item with its visibility, in display order. */
  entries: SidebarNavEntry[];
  /** Visible items only, in display order. what the nav renders. */
  visibleItems: SidebarNavItem[];
  /** True until the stored layout has been loaded. */
  loading: boolean;
  saving: boolean;
  /** Set when loading or saving the layout failed. */
  error: string | null;
  /** Persist a layout. Applied optimistically and rolled back on failure. */
  save: (entries: SidebarNavEntry[]) => Promise<void>;
  /** Clear the stored layout. default order, everything visible. */
  reset: () => Promise<void>;
}

const SidebarNavContext = createContext<SidebarNavContextValue | null>(null);

/**
 * Holds the user's sidebar layout so the nav and the settings editor stay in
 * sync: the sidebar re-renders the moment a layout is saved.
 */
export function SidebarNavProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<SidebarNavEntry[]>(defaultSidebarNav);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saves run one after another, and only the newest one may adopt the server's
  // answer. otherwise a slow earlier response would undo a later layout.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveSeq = useRef(0);
  const pendingSaves = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ items: SidebarNavEntry[] }>(SIDEBAR_NAV_URL);
      setEntries(normalizeSidebarNav(data.items));
      setError(null);
    } catch (err) {
      console.error("Failed to load sidebar navigation layout:", err);
      setError("Couldn't load your sidebar layout");
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const persist = useCallback(
    async (body: { items: SidebarNavEntry[] | null }, optimistic: SidebarNavEntry[]) => {
      setEntries(optimistic);
      setError(null);
      pendingSaves.current += 1;
      setSaving(true);

      const seq = ++saveSeq.current;
      const run = saveQueue.current.then(async () => {
        try {
          const data = await patchJson<{ items: SidebarNavEntry[] }>(SIDEBAR_NAV_URL, body);
          if (seq === saveSeq.current) setEntries(normalizeSidebarNav(data.items));
        } catch (err) {
          console.error("Failed to save sidebar navigation layout:", err);
          if (seq === saveSeq.current) {
            setError("Couldn't save your sidebar layout");
            await load();
          }
        }
      });

      saveQueue.current = run;
      await run;
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) setSaving(false);
    },
    [load],
  );

  const save = useCallback(
    (next: SidebarNavEntry[]) => persist({ items: next }, normalizeSidebarNav(next)),
    [persist],
  );

  const reset = useCallback(() => persist({ items: null }, defaultSidebarNav()), [persist]);

  const value = useMemo<SidebarNavContextValue>(
    () => ({
      entries,
      visibleItems: visibleSidebarNavItems(entries),
      loading,
      saving,
      error,
      save,
      reset,
    }),
    [entries, loading, saving, error, save, reset],
  );

  return <SidebarNavContext.Provider value={value}>{children}</SidebarNavContext.Provider>;
}

export function useSidebarNav(): SidebarNavContextValue {
  const value = useContext(SidebarNavContext);
  if (!value) {
    throw new Error("useSidebarNav must be used within a SidebarNavProvider");
  }
  return value;
}
