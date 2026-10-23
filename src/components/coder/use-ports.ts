"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, postJson } from "@/lib/http";
import type { ChatPorts } from "@/lib/coder/ports";

/** What the operator has to put in front of the proxy. */
export interface PreviewSetupInfo {
  domain: string;
  nginx: string;
  /** Null while previews are off: there is nothing to probe yet. */
  probeUrl: string | null;
}

export interface CoderPortsResponse extends ChatPorts {
  setup: PreviewSetupInfo;
}

/** How often a visible Ports tab asks again. A dev server can appear any time. */
const POLL_MS = 3000;

/**
 * A chat's listening ports, polled while the tab is open.
 *
 * Polling stops with the tab and comes back when the window regains focus, so a
 * panel left open in a background tab costs nothing.
 */
export function usePorts(sessionId: string | null, active: boolean) {
  const [data, setData] = useState<CoderPortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null);
      return;
    }
    const ticket = ++latest.current;
    try {
      const body = await fetchJson<CoderPortsResponse>(
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
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
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
