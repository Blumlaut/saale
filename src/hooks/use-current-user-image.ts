"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";

/**
 * The signed-in user's picture URL, shared by every avatar of theirs on screen.
 * One `/api/auth/get-session` per page load; `setCurrentUserImage` replaces it
 * after an upload, so the new picture shows without a reload.
 */

interface SessionPayload {
  user?: { image?: string | null } | null;
}

let current: string | null = null;
let loaded = false;
let pending: Promise<string | null> | null = null;
const listeners = new Set<(image: string | null) => void>();

function publish(image: string | null): void {
  current = image;
  loaded = true;
  for (const listener of listeners) listener(image);
}

function load(): Promise<string | null> {
  pending ??= fetchJson<SessionPayload | null>("/api/auth/get-session")
    .then((data) => {
      publish(data?.user?.image ?? null);
      return current;
    })
    .catch((err) => {
      // Left unloaded on purpose: the next avatar to mount asks again.
      console.error("Failed to load the signed-in user's picture:", err);
      return current;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Replace the picture every mounted avatar draws. */
export function setCurrentUserImage(image: string | null): void {
  publish(image);
}

/** Drop the cached picture. tests only. */
export function resetCurrentUserImage(): void {
  current = null;
  loaded = false;
  pending = null;
  listeners.clear();
}

/** The signed-in user's picture URL, or null when they have none (or it failed). */
export function useCurrentUserImage(): string | null {
  const [image, setImage] = useState<string | null>(current);

  useEffect(() => {
    listeners.add(setImage);
    if (loaded) setImage(current);
    else void load();
    return () => {
      listeners.delete(setImage);
    };
  }, []);

  return image;
}
