import { useEffect } from "react";
import { useOnResume } from "@/hooks/use-on-resume";

/**
 * Ask the server again on an interval, and once more when the page comes back.
 *
 * A page that is hidden stops mattering: the interval is throttled by the
 * browser and a frozen tab runs nothing, so the resume refresh is what makes the
 * data current after a suspension rather than up to an interval stale.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [callback, intervalMs, enabled]);

  useOnResume(() => {
    if (enabled) callback();
  });
}
