"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { postJson, type FetchError } from "@/lib/http";
import { writeFileUrl } from "@/lib/files/urls";

/** What the write endpoint reports back. */
export interface FileWriteResult {
  path: string;
  size: number;
  modified: number;
}

export interface FileSaveController {
  /** The editor holds text the file on disk does not. */
  dirty: boolean;
  saving: boolean;
  /** A save that failed for a reason the user has to read. */
  error: string;
  /** Report what the editor now holds. */
  onChange: (content: string) => void;
  save: () => void;
}

/**
 * The editor's text, written back to its file.
 *
 * The whole buffer goes up on every save: Monaco owns the content, and a patch
 * protocol would only be a second copy of it to keep in step.
 *
 * A 409 means something else wrote the file while it was open. In a coder chat
 * that is an agent, so the conflict is a toast with the overwrite on it rather
 * than a failed save the user has to work out.
 */
export function useFileSave({
  target,
  path,
  baseModified,
  enabled,
  saved,
  onSaved,
}: {
  target: string;
  path: string;
  /** The mtime the text on screen came from; null while it is still loading. */
  baseModified: number | null;
  /** False for a workspace the browser cannot write to. */
  enabled: boolean;
  /** The file's text as last read or written; null while it is loading. */
  saved: string | null;
  onSaved: (content: string, modified: number) => void;
}): FileSaveController {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Typing must not re-render the editor's host, so the buffer lives in a ref
  // and only the yes/no of "unsaved" is state.
  const draftRef = useRef<string | null>(null);
  const savedRef = useRef(saved);
  const baseModifiedRef = useRef(baseModified);
  const savingRef = useRef(false);

  // A file the caller swapped out: whatever was typed belongs to the old one.
  useEffect(() => {
    draftRef.current = null;
    setDirty(false);
    setError("");
  }, [target, path]);

  useEffect(() => {
    savedRef.current = saved;
    baseModifiedRef.current = baseModified;
    setDirty(draftRef.current !== null && draftRef.current !== saved);
  }, [saved, baseModified]);

  // A reload with unsaved edits loses them, so the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onChange = useCallback((content: string) => {
    draftRef.current = content;
    const next = content !== savedRef.current;
    setDirty((current) => (current === next ? current : next));
  }, []);

  // A plain function, not a useCallback: the overwrite action on the conflict
  // toast has to reach the save that is running now, and a memoized one would
  // reach the render it was created in.
  async function save(force = false): Promise<void> {
    const content = draftRef.current;
    if (!enabled || content === null || savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const base = baseModifiedRef.current;
      const result = await postJson<FileWriteResult>(writeFileUrl(target), {
        path,
        content,
        ...(base === null ? {} : { baseModified: base }),
        ...(force ? { force } : {}),
      });
      draftRef.current = null;
      setDirty(false);
      onSaved(content, result.modified);
    } catch (err) {
      // Only a mtime mismatch is offered an overwrite; any other 409 (an
      // unreachable workspace) is a failure to read out.
      if ((err as FetchError).code === "modified") {
        toast.warning("This file changed on disk", {
          description: "Something wrote it while you were editing.",
          action: { label: "Overwrite", onClick: () => void save(true) },
        });
        return;
      }
      console.error("Failed to save file:", err);
      setError(err instanceof Error ? err.message : "Could not save this file.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return { dirty, saving, error, onChange, save: () => void save() };
}
