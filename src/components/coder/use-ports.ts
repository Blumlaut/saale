"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, postJson } from "@/lib/http";
import type { ChatPorts } from "@/lib/coder/ports";

/** How often a visible Ports tab asks again. A dev server can appear any time. */
const POLL_MS = 3000;
/** A slower beat while another tab is open, which is enough for the badge. */
const IDLE_POLL_MS = 10_000;

/**
 * A chat's listening ports, polled while the panel is open.
 *
 * The tab's own poll is fast; the badge that says a port is up gets a slower
 * one. Both stop when the window is hidden, so a background tab costs nothing.
 */
export function usePorts(sessionId: string | null, active: boolean) {
  const [data, setData] = useState<ChatPorts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null);
      return;
    }
    const ticket = ++latest.current;
    try {
      const body = await fetchJson<ChatPorts>(
        `/api/coder/sessions/${encodeURIComponent(sessionId)}/ports`,
      );
      if (ticket !== latest.current) return;
      setData(body);
      setError(null);
    } catch (err) {
      if (ticket !== latest.current) return;
      console.error(`Failed to list ports for ${sessionId}:`, err);
      setError(err instanceof Error ? err.message : "Could not read the ports");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), active ? POLL_MS : IDLE_POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, load]);

  const stop = useCallback(
    async (port: number) => {
      if (!sessionId) return;
      await postJson(`/api/coder/sessions/${encodeURIComponent(sessionId)}/ports/${port}/kill`, {});
      await load();
    },
    [sessionId, load],
  );

  return { data, error, load, stop };
}
