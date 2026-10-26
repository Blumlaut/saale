"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * View preferences that outlive a visit: which tab a page opens on, whether a
 * list starts folded, whether the browser shows dotfiles.
 *
 * They live in this browser's localStorage. The server has no opinion about a
 * column width or a folded group, so a preference costs it nothing and follows
 * the user between visits without a round trip. Values are JSON, one key each,
 * and an unreadable or unexpected value falls back rather than throwing.
 */

/** Keeps these keys apart from the chat drafts and anything else stored. */
const KEY_PREFIX = "saale:ui:";

export type PersistedStateSetter<T> = (next: T | ((current: T) => T)) => void;

export interface PersistedStateOptions<T> {
  /** Rejects a value an older build left behind; the fallback wins instead. */
  validate?: (value: unknown) => value is T;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** A guard for a preference that only ever holds one of a few strings. */
export function oneOf<T extends string>(...allowed: readonly T[]): (value: unknown) => value is T {
  return (value): value is T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** A guard for a preference that holds a list, such as the folded task groups. */
export function arrayOf<T>(
  guard: (value: unknown) => value is T,
): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

function readStored<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch (err) {
    console.error(`Failed to read the ${key} preference:`, err);
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch (err) {
    // A full or blocked store only costs the next visit the preference.
    console.error(`Failed to keep the ${key} preference:`, err);
  }
}

/**
 * State that is remembered between visits.
 *
 * The stored value arrives in an effect, never during the first render: the
 * server has no storage, so a first client paint that already used one would
 * hydrate markup the server did not send. `restored` says when the read has
 * happened, for a caller whose first fetch depends on the value.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  options: PersistedStateOptions<T> = {},
): [T, PersistedStateSetter<T>, boolean] {
  // The fallback and the guard are captured once: a caller passing a fresh
  // array or arrow on every render must not re-run the read.
  const [initial] = useState(() => ({ fallback, validate: options.validate }));
  const [value, setValue] = useState<T>(initial.fallback);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setValue(readStored(key, initial.fallback, initial.validate));
    setRestored(true);
  }, [key, initial]);

  useEffect(() => {
    if (!restored) return;
    writeStored(key, value);
  }, [key, restored, value]);

  const set = useCallback<PersistedStateSetter<T>>((next) => {
    setValue((current) =>
      typeof next === "function" ? (next as (current: T) => T)(current) : next,
    );
  }, []);

  return [value, set, restored];
}
