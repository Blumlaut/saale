"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";

/**
 * One collection of instance-owned rows, as its admin page edits it.
 *
 * Add, edit and delete all go through the same four routes, so a page only has
 * to name the collection; the list is reloaded after a write, since the server
 * is what decides the canonical row.
 */
export function useAdminCollection<T extends { id: string }>(options: {
  /** Collection route, e.g. `/api/admin/shared-prompts`. */
  url: string;
  /** The key the GET answers with, e.g. `prompts`. */
  key: string;
}) {
  const { url, key } = options;
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<Record<string, T[]>>(url);
      setItems(data[key] ?? []);
    } catch (err) {
      console.error(`Failed to load ${url}:`, err);
    } finally {
      setLoading(false);
    }
  }, [url, key]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(
    async (input: unknown) => {
      await postJson(url, input);
      await load();
    },
    [url, load],
  );

  const update = useCallback(
    async (id: string, input: unknown) => {
      await patchJson(`${url}/${id}`, input);
      await load();
    },
    [url, load],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteJson(`${url}/${id}`);
      await load();
    },
    [url, load],
  );

  return { items, loading, load, create, update, remove };
}
