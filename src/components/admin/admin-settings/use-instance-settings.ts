"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteJson, fetchJson, patchJson } from "@/lib/http";
import { useSaveStatus } from "./use-admin-settings";

/**
 * An admin settings page backed by a row of its own: mail, single sign-on.
 *
 * The page reads the row on mount, edits a draft, and saves or removes it. The
 * two pages differ in their fields and their copy, so those stay with them.
 */
export function useInstanceSettings<Status, Draft>({
  url,
  key,
  toDraft,
  toPatch,
  onApply,
}: {
  /** The admin API the row lives behind. */
  url: string;
  /** The row's name in that API's responses, e.g. "mail". */
  key: string;
  toDraft: (status: Status) => Draft;
  toPatch: (draft: Draft) => Record<string, unknown>;
  /** Runs after every read or save, for state the page derives from the row. */
  onApply?: (status: Status) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { saveStatus, setSaveStatus } = useSaveStatus();

  // Held in a ref so a caller's inline callbacks do not restart the load. The
  // effect that writes it runs before the one that fetches.
  const options = useRef({ url, key, toDraft, toPatch, onApply });
  useEffect(() => {
    options.current = { url, key, toDraft, toPatch, onApply };
  });

  const apply = useCallback((next: Status) => {
    setStatus(next);
    setDraft(options.current.toDraft(next));
    options.current.onApply?.(next);
  }, []);

  useEffect(() => {
    const { url: endpoint, key: field } = options.current;
    fetchJson<Record<string, Status>>(endpoint)
      .then((data) => apply(data[field] as Status))
      .catch((err) => console.error(`Failed to load ${endpoint}:`, err))
      .finally(() => setLoading(false));
  }, [apply]);

  const edit = useCallback((change: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...change } : current));
  }, []);

  const save = useCallback(async (): Promise<Error | null> => {
    if (!draft) return new Error("The settings are still loading");

    const { url: endpoint, key: field, toPatch: buildPatch } = options.current;
    setSaving(true);
    try {
      const data = await patchJson<Record<string, Status>>(endpoint, buildPatch(draft));
      apply(data[field] as Status);
      setSaveStatus("success");
      return null;
    } catch (err) {
      console.error(`Failed to save ${endpoint}:`, err);
      setSaveStatus("error");
      return err instanceof Error ? err : new Error("The request failed");
    } finally {
      setSaving(false);
    }
  }, [apply, draft, setSaveStatus]);

  const remove = useCallback(async (): Promise<Error | null> => {
    const { url: endpoint, key: field } = options.current;
    setRemoving(true);
    try {
      const data = await deleteJson<Record<string, Status>>(endpoint);
      apply(data[field] as Status);
      return null;
    } catch (err) {
      console.error(`Failed to remove ${endpoint}:`, err);
      return err instanceof Error ? err : new Error("The request failed");
    } finally {
      setRemoving(false);
    }
  }, [apply]);

  return {
    status,
    draft,
    loading,
    saving,
    removing,
    saveStatus,
    edit,
    save,
    remove,
  };
}
