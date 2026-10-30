"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchJson, postJson, type FetchError } from "@/lib/http";
import { HIDE_DOTFILES_DEFAULT, MAX_UPLOAD_FILES } from "@/lib/files/config";
import { uploadFile, type UploadFailure, type UploadProgress } from "@/lib/files/upload-client";
import { isBoolean, usePersistedState } from "@/hooks/use-persisted-state";
import type { FileEntry, FileListing } from "@/lib/files/types";

/** Where the browser is, what it is showing, and what is selected. */
export interface FileBrowserController {
  listing: FileListing | null;
  /** Absolute path being browsed; empty until the first listing arrives. */
  path: string;
  loading: boolean;
  /** A background refresh is running over an already-visible listing. */
  refreshing: boolean;
  /** The folder the browser opened at, absolute; empty until the first listing. */
  home: string;
  /** Whether {@link up} has somewhere to go. */
  canGoUp: boolean;
  error: string;
  hideDotfiles: boolean;
  setHideDotfiles: (hide: boolean) => void;
  /** Selected paths, and the rows they resolve to in listing order. */
  selected: Set<string>;
  selectedEntries: FileEntry[];
  toggle: (entry: FileEntry, options?: { range?: boolean }) => void;
  selectAll: () => void;
  clearSelection: () => void;
  open: (path: string) => void;
  up: () => void;
  refresh: () => void;
  createFolder: (name: string) => Promise<boolean>;
  createFile: (name: string) => Promise<boolean>;
  rename: (entry: FileEntry, name: string) => Promise<boolean>;
  remove: (entries: FileEntry[]) => Promise<boolean>;
  upload: (files: File[], options?: { overwrite?: boolean }) => Promise<boolean>;
  /** Where the batch in flight has got to, or null when nothing is uploading. */
  uploadProgress: UploadProgress | null;
  downloadUrl: (entry: FileEntry) => string;
  zipUrl: () => string;
  /** Archive URL for an explicit set of rows. used by a folder's row menu. */
  zipUrlFor: (entries: FileEntry[]) => string;
}

export interface UseFileBrowserOptions {
  /** Workspace token: `user`, or `council:<id>`. */
  target: string;
  /**
   * Where browsing starts, relative to the workspace root. A caller that shows
   * one directory (a worktree) passes it here, and going up stops there.
   */
  startPath?: string;
  onError?: (message: string) => void;
}

/**
 * The file browser's data layer.
 *
 * Two things are deliberately not naive. Every request carries a sequence
 * number and only the newest may write state, so a slow listing cannot replace
 * a folder the user has already left. And navigation keeps the previous listing
 * on screen while the next one loads (`refreshing`) instead of blanking the
 * panel. a folder switch that flashes empty reads as a failure.
 */
/** What the upload endpoints reported, one entry per file that did not land. */
type UploadSkipped = { name: string; reason: UploadFailure; message: string };
type UploadOutcome =
  { ok: true; uploaded: string[]; skipped: UploadSkipped[] } | { ok: false; message: string };

/**
 * Say what happened to an upload.
 *
 * Module-level on purpose: the conflict case offers a retry that reports itself
 * again, and a component-scoped callback cannot reference itself.
 */
function reportUpload(
  files: File[],
  outcome: UploadOutcome,
  retry: (files: File[]) => Promise<UploadOutcome>,
  report: (message: string) => void,
): void {
  if (!outcome.ok) {
    report(outcome.message);
    return;
  }

  // Replacing a file an agent may be working in is never implicit: the server
  // reports the conflicts and this offers the one way to force it.
  const conflicts = outcome.skipped.filter((skip) => skip.reason === "exists");
  if (conflicts.length > 0) {
    toast.warning(
      `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} already exist here`,
      {
        description: "Nothing was replaced.",
        action: {
          label: "Overwrite",
          onClick: () => void retry(files).then((next) => reportUpload(files, next, retry, report)),
        },
      },
    );
  } else if (outcome.uploaded.length > 0) {
    toast.success(
      `Uploaded ${outcome.uploaded.length} file${outcome.uploaded.length === 1 ? "" : "s"}`,
    );
  }

  const rejected = outcome.skipped.filter((skip) => skip.reason !== "exists");
  if (rejected.length > 0) {
    report(rejected.map((skip) => `${skip.name}: ${skip.message}`).join(" "));
  }
}

export function useFileBrowser({
  target,
  startPath,
  onError,
}: UseFileBrowserOptions): FileBrowserController {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [path, setPath] = useState("");
  const [home, setHome] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [hideDotfiles, setHideDotfiles, preferenceRead] = usePersistedState(
    "files:hideDotfiles",
    HIDE_DOTFILES_DEFAULT,
    { validate: isBoolean },
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const sequence = useRef(0);
  const anchor = useRef<number | null>(null);
  /** The workspace root, for the recovery path. read from a ref so a fetch
   * effect never depends on the listing it is about to replace. */
  const root = useRef("");
  /** The path of the newest request, so a stale reply is discarded. */
  const current = useRef("");
  /** The directory the caller opened the browser at. never navigated above it. */
  const start = useRef(startPath ?? "");

  const report = useCallback(
    (message: string) => {
      onError?.(message);
      toast.error(message);
    },
    [onError],
  );

  const fetchListing = useCallback(
    async (dir: string): Promise<FileListing> => {
      const query = new URLSearchParams({ target, hideDotfiles: hideDotfiles ? "1" : "0" });
      if (dir) query.set("path", dir);
      return fetchJson<FileListing>(`/api/files/list?${query.toString()}`);
    },
    [target, hideDotfiles],
  );

  const load = useCallback(
    async (dir: string, options: { quiet?: boolean } = {}) => {
      const ticket = (sequence.current += 1);
      current.current = dir;
      if (options.quiet) setRefreshing(true);
      else setLoading(true);

      try {
        let body: FileListing;
        try {
          body = await fetchListing(dir);
        } catch (err) {
          // The folder went away (an agent deleted or renamed it): step up to
          // the parent rather than leaving the browser pointed at nothing.
          const parent =
            dir && root.current && dir !== root.current
              ? dir.slice(0, dir.lastIndexOf("/")) || root.current
              : "";
          if ((err as FetchError).status !== 404 || !parent) throw err;
          body = await fetchListing(parent);
          if (ticket === sequence.current) setSelected(new Set());
        }

        if (ticket !== sequence.current) return;
        root.current = body.target.root;
        setListing(body);
        setPath(body.path);
        // The server resolves a relative start path, so home is only known here.
        setHome((current) => current || body.path);
        setError("");
      } catch (err) {
        if (ticket !== sequence.current) return;
        setError(err instanceof Error ? err.message : "Could not list this workspace.");
      } finally {
        if (ticket === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetchListing],
  );

  /** Whether the first listing has been asked for. */
  const started = useRef(false);
  /** The dotfile preference the visible listing was read with. */
  const filteredBy = useRef(hideDotfiles);

  // The first listing waits for the stored preference, so a browser that was
  // last left showing dotfiles opens on them instead of asking twice.
  useEffect(() => {
    if (!preferenceRead || started.current) return;
    started.current = true;
    filteredBy.current = hideDotfiles;
    void load(start.current);
  }, [hideDotfiles, load, preferenceRead]);

  // Dotfiles are filtered server-side, so a change reads the folder again.
  useEffect(() => {
    if (!preferenceRead || !started.current || filteredBy.current === hideDotfiles) return;
    filteredBy.current = hideDotfiles;
    void load(current.current, { quiet: true });
  }, [hideDotfiles, load, preferenceRead]);

  // A caller that moves to another directory is browsing another workspace:
  // the rows on screen belong to a root the user is no longer in.
  useEffect(() => {
    const next = startPath ?? "";
    if (next === start.current) return;
    start.current = next;
    if (!preferenceRead) return;
    root.current = "";
    setListing(null);
    setHome("");
    setSelected(new Set());
    void load(next);
  }, [load, preferenceRead, startPath]);

  /** Re-read the current folder after a write, keeping the listing on screen. */
  const afterMutation = useCallback(async () => {
    setSelected(new Set());
    await load(current.current, { quiet: true });
  }, [load]);

  const createFolder = useCallback(
    async (name: string) => {
      try {
        await postJson("/api/files/mkdir", { path, name });
        await afterMutation();
        return true;
      } catch (err) {
        report(err instanceof Error ? err.message : "Could not create that folder.");
        return false;
      }
    },
    [path, afterMutation, report],
  );

  const createFile = useCallback(
    async (name: string) => {
      try {
        await postJson("/api/files/create", { path, name });
        await afterMutation();
        return true;
      } catch (err) {
        report(err instanceof Error ? err.message : "Could not create that file.");
        return false;
      }
    },
    [path, afterMutation, report],
  );

  const rename = useCallback(
    async (entry: FileEntry, name: string) => {
      try {
        await postJson("/api/files/rename", { path: entry.path, name });
        await afterMutation();
        return true;
      } catch (err) {
        report(err instanceof Error ? err.message : "Could not rename that.");
        return false;
      }
    },
    [afterMutation, report],
  );

  const remove = useCallback(
    async (entries: FileEntry[]) => {
      try {
        for (const entry of entries) {
          await postJson("/api/files/delete", { path: entry.path });
        }
        await afterMutation();
        return true;
      } catch (err) {
        report(err instanceof Error ? err.message : "Could not delete that.");
        return false;
      }
    },
    [afterMutation, report],
  );

  /**
   * Send the batch and refresh; success or failure is reported by the caller.
   *
   * Files go one at a time: the workspace is a folder the user is watching, and
   * a batch that streams in order is easier to follow than one bar for four
   * files moving together.
   */
  const applyUpload = useCallback(
    async (files: File[], overwrite: boolean): Promise<UploadOutcome> => {
      if (files.length === 0) return { ok: true, uploaded: [], skipped: [] };
      if (files.length > MAX_UPLOAD_FILES) {
        return { ok: false, message: `Upload at most ${MAX_UPLOAD_FILES} files at a time` };
      }

      // The resolved folder, not what was asked for: the server hands back
      // absolute paths, and an upload into the root names it.
      const dir = path;
      const uploaded: string[] = [];
      const skipped: UploadSkipped[] = [];

      try {
        for (const [position, file] of files.entries()) {
          const result = await uploadFile(file, {
            target,
            dir,
            overwrite,
            batch: { index: position + 1, count: files.length },
            onProgress: setUploadProgress,
          });
          if (result.ok) uploaded.push(result.name);
          else skipped.push({ name: result.name, reason: result.reason, message: result.message });
        }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Upload failed." };
      } finally {
        setUploadProgress(null);
      }

      await afterMutation();
      return { ok: true, uploaded, skipped };
    },
    [target, path, afterMutation],
  );

  const retryUpload = useCallback((files: File[]) => applyUpload(files, true), [applyUpload]);

  const upload = useCallback(
    async (files: File[], options: { overwrite?: boolean } = {}) => {
      if (files.length === 0) return false;
      const outcome = await applyUpload(files, options.overwrite ?? false);
      reportUpload(files, outcome, retryUpload, report);
      return outcome.ok;
    },
    [applyUpload, retryUpload, report],
  );

  const open = useCallback(
    (next: string) => {
      setSelected(new Set());
      anchor.current = null;
      void load(next);
    },
    [load],
  );

  // A caller that opened one directory keeps the browser inside it, but a
  // breadcrumb to an ancestor is open travel: up climbs from there too.
  const canGoUp = Boolean(listing && path && path !== listing.target.root && path !== home);

  const up = useCallback(() => {
    if (!canGoUp || !root.current) return;
    open(path.slice(0, path.lastIndexOf("/")) || root.current);
  }, [canGoUp, path, open]);

  /** Re-read the current folder without dropping what is on screen. */
  const refresh = useCallback(() => {
    void load(current.current, { quiet: true });
  }, [load]);

  const toggle = useCallback(
    (entry: FileEntry, options: { range?: boolean } = {}) => {
      const order = listing?.entries ?? [];
      const index = order.findIndex((candidate) => candidate.path === entry.path);

      setSelected((currentSelection) => {
        const next = new Set(currentSelection);
        // Shift extends from the last entry touched, which is what a list is
        // expected to do.
        if (options.range && anchor.current !== null && index !== -1) {
          const low = Math.min(anchor.current, index);
          const high = Math.max(anchor.current, index);
          const adding = !currentSelection.has(entry.path);
          for (const candidate of order.slice(low, high + 1)) {
            if (adding) next.add(candidate.path);
            else next.delete(candidate.path);
          }
          return next;
        }

        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        anchor.current = index === -1 ? null : index;
        return next;
      });
    },
    [listing],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set((listing?.entries ?? []).map((entry) => entry.path)));
  }, [listing]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const downloadUrl = useCallback(
    (entry: FileEntry) => {
      const query = new URLSearchParams({ target, path: entry.path, download: "1" });
      return `/api/files/raw?${query.toString()}`;
    },
    [target],
  );

  const zipUrlFor = useCallback(
    (entries: FileEntry[]) => {
      const query = new URLSearchParams({ target, includeDotfiles: hideDotfiles ? "0" : "1" });
      if (current.current) query.set("dir", current.current);
      for (const entry of entries) query.append("path", entry.path);
      return `/api/files/zip?${query.toString()}`;
    },
    [target, hideDotfiles],
  );

  const selectedEntries = (listing?.entries ?? []).filter((entry) => selected.has(entry.path));

  const zipUrl = useCallback(() => zipUrlFor(selectedEntries), [zipUrlFor, selectedEntries]);

  return {
    listing,
    path,
    home,
    canGoUp,
    loading,
    refreshing,
    error,
    hideDotfiles,
    setHideDotfiles,
    selected,
    selectedEntries,
    toggle,
    selectAll,
    clearSelection,
    open,
    up,
    refresh,
    createFolder,
    createFile,
    rename,
    remove,
    upload,
    uploadProgress,
    downloadUrl,
    zipUrl,
    zipUrlFor,
  };
}
