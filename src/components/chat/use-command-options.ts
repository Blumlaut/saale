"use client";

import { useCallback, useRef, useState } from "react";

import { fetchCommandOptions } from "@/lib/chat/run-command";
import type { CommandOptions } from "@/lib/commands/types";

/** What the composer has been told about the command it is filling in. */
export interface ListedCommandOptions {
  name: string;
  values: CommandOptions;
}

/**
 * The values of a command's arguments that only the server can list.
 *
 * `/image size:` offers the account's image model resolutions, which depend on
 * the model rather than on the catalog. One fetch per command is enough: the
 * list does not change while the composer is open.
 */
export function useCommandOptions(sessionId: string): {
  listed: ListedCommandOptions | null;
  request: (name: string) => void;
} {
  const [listed, setListed] = useState<ListedCommandOptions | null>(null);
  const cache = useRef(new Map<string, CommandOptions>());
  const pending = useRef(new Set<string>());

  const request = useCallback(
    (name: string) => {
      const cached = cache.current.get(name);
      if (cached) {
        setListed({ name, values: cached });
        return;
      }
      if (pending.current.has(name)) return;
      pending.current.add(name);

      void fetchCommandOptions(sessionId, name)
        .then((values) => {
          cache.current.set(name, values);
          setListed({ name, values });
        })
        .catch((err) => {
          console.error(`Failed to list the options of /${name}:`, err);
          // Remember the failure as an empty list so the composer does not ask
          // again on every keystroke; the rows simply fall back to free text.
          cache.current.set(name, {});
          setListed({ name, values: {} });
        })
        .finally(() => pending.current.delete(name));
    },
    [sessionId],
  );

  return { listed, request };
}
