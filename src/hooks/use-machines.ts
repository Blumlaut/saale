"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";
import type { InfraMachine } from "@/lib/infra/types";

export interface MachinesState {
  machines: InfraMachine[];
  loading: boolean;
  /** Why the list could not be read, when it could not. */
  error: string | null;
  reload: () => Promise<void>;
  /** Drop a machine the server no longer has. */
  forget: (id: string) => void;
}

/** The user's registered machines, for the infra page and the files page. */
export function useMachines(): MachinesState {
  const [machines, setMachines] = useState<InfraMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await fetchJson<{ machines: InfraMachine[] }>("/api/infra/machines");
      setMachines(data.machines ?? []);
      setError(null);
    } catch (err) {
      console.error("Failed to load the machines:", err);
      setError(err instanceof Error ? err.message : "Could not list your machines");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const forget = useCallback((id: string) => {
    setMachines((current) => current.filter((machine) => machine.id !== id));
  }, []);

  return { machines, loading, error, reload, forget };
}
