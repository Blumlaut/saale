"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { postJson } from "@/lib/http";

/**
 * Report the page on screen, so a notification's phone copy is dropped once the
 * user has read what it was about.
 *
 * The service worker does the same when a notification lands on the page it
 * opens. This covers coming back to that page later: a reply pushed to a
 * computer that nobody was sitting at should not buzz a phone once it has been
 * read.
 */
export function PushSeenReporter() {
  const pathname = usePathname();

  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== "visible") return;

      void postJson("/api/push/seen", { url: pathname }).catch((err) => {
        console.error(`Failed to report ${pathname} as seen:`, err);
      });
    };

    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [pathname]);

  return null;
}
