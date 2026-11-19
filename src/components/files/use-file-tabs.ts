"use client";

import { useCallback, useMemo, useState } from "react";
import type { FileEntry } from "@/lib/files/types";

/** One file open in the editor, and the workspace it came from. */
export interface OpenFile {
  /** `target:path`, so the same path on two machines is two tabs. */
  id: string;
  target: string;
  entry: FileEntry;
}

export interface FileTabs {
  files: OpenFile[];
  activeId: string | null;
  active: OpenFile | null;
  /** Tabs holding text that is not on disk yet. */
  dirty: Set<string>;
  /** Open a file, or bring the tab it already has to the front. */
  open: (target: string, entry: FileEntry) => void;
  activate: (id: string) => void;
  /** Drop a tab. The caller asks about unsaved text first. */
  close: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  /** Forget every tab: another workspace is another set of files. */
  clear: () => void;
}

/** The strip, kept as one value so a tab and its buffer cannot disagree. */
interface TabState {
  files: OpenFile[];
  activeId: string | null;
  dirty: Set<string>;
}

const emptyTabs = (): TabState => ({ files: [], activeId: null, dirty: new Set() });

/** The editor's open files, in the order they were opened. */
export function useFileTabs(): FileTabs {
  const [state, setState] = useState<TabState>(emptyTabs);

  const open = useCallback((target: string, entry: FileEntry) => {
    const id = `${target}:${entry.path}`;
    setState((current) => ({
      ...current,
      files: current.files.some((file) => file.id === id)
        ? current.files
        : [...current.files, { id, target, entry }],
      activeId: id,
    }));
  }, []);

  const close = useCallback((id: string) => {
    setState((current) => {
      const index = current.files.findIndex((file) => file.id === id);
      if (index === -1) return current;

      const files = current.files.filter((file) => file.id !== id);
      const dirty = new Set(current.dirty);
      dirty.delete(id);

      return {
        files,
        // The tab to the left takes over, the way a closed tab is expected to
        // behave; an empty strip has nothing active.
        activeId:
          current.activeId === id ? (files[Math.max(0, index - 1)]?.id ?? null) : current.activeId,
        dirty,
      };
    });
  }, []);

  const setDirty = useCallback((id: string, value: boolean) => {
    setState((current) => {
      if (current.dirty.has(id) === value) return current;
      const dirty = new Set(current.dirty);
      if (value) dirty.add(id);
      else dirty.delete(id);
      return { ...current, dirty };
    });
  }, []);

  const activate = useCallback(
    (id: string) => setState((current) => ({ ...current, activeId: id })),
    [],
  );

  const clear = useCallback(() => setState(emptyTabs()), []);

  const active = useMemo(
    () => state.files.find((file) => file.id === state.activeId) ?? null,
    [state],
  );

  return {
    files: state.files,
    activeId: state.activeId,
    active,
    dirty: state.dirty,
    open,
    activate,
    close,
    setDirty,
    clear,
  };
}
