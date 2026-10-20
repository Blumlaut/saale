"use client";

import { useEffect, useState } from "react";
import { isPiThinkingLevel } from "@/lib/pi/thinking-levels";

export interface ModelThinkingLevels {
  /** The model's levels (`getSupportedThinkingLevels`), or `null` while unknown. */
  levels: string[] | null;
  /** Whether the model reasons at all, or `null` while unknown. */
  reasoning: boolean | null;
  /** What Pi clamps the requested level to when the model lacks it. */
  clampedLevel: string | null;
  /** The requested level is a real one this model doesn't offer. */
  unsupported: boolean;
}

/**
 * What Pi allows for a model, asked of Pi rather than assumed locally.
 *
 * `levels` stays `null` when the lookup can't run or fails, which means "no
 * idea". not "this model supports nothing". Treating the unknown state as an
 * empty list left a thinking model with only "Default" to choose from, and
 * permanently so once the request failed.
 *
 * "Default" is never a model capability (it means "don't override Pi"), so it
 * is never reported as unsupported.
 */
export function useModelThinkingLevels(
  provider: string | null | undefined,
  model: string | null | undefined,
  level: string,
): ModelThinkingLevels {
  const [levels, setLevels] = useState<string[] | null>(null);
  const [reasoning, setReasoning] = useState<boolean | null>(null);
  const [clampedLevel, setClampedLevel] = useState<string | null>(null);

  useEffect(() => {
    if (!provider || !model) {
      setLevels(null);
      setReasoning(null);
      return;
    }

    let cancelled = false;
    setLevels(null);
    setReasoning(null);

    fetch(
      `/api/models/thinking-levels?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    )
      .then(async (r) =>
        r.ok ? ((await r.json()) as { levels?: string[]; reasoning?: boolean }) : null,
      )
      .then((data) => {
        if (cancelled || !data) return;
        setLevels(data.levels ?? []);
        setReasoning(data.reasoning ?? null);
      })
      .catch((err) => {
        console.error("Failed to fetch thinking levels:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [provider, model]);

  const unsupported =
    isPiThinkingLevel(level) && levels !== null && levels.length > 0 && !levels.includes(level);

  // Only ever shown next to the warning, so only ask for it when it will be.
  useEffect(() => {
    if (!unsupported || !provider || !model) {
      setClampedLevel(null);
      return;
    }

    let cancelled = false;

    fetch(
      `/api/models/thinking-levels?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&level=${encodeURIComponent(level)}`,
    )
      .then(async (r) => (r.ok ? ((await r.json()) as { clampedLevel?: string }) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setClampedLevel(data.clampedLevel ?? null);
      })
      .catch((err) => {
        console.error("Failed to fetch the clamped thinking level:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [unsupported, provider, model, level]);

  return { levels, reasoning, clampedLevel, unsupported };
}
