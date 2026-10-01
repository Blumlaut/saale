"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (see `public/sw.js`).
 *
 * Rendered once from the root layout. The registration URL carries the running
 * mode because Turbopack rewrites development chunk URLs in place — the worker
 * skips asset caching in development so an edit can never be shadowed by a
 * stale bundle.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      const params = new URLSearchParams({ mode: process.env.NODE_ENV });
      navigator.serviceWorker
        .register(`/sw.js?${params.toString()}`, { scope: "/", updateViaCache: "none" })
        .catch((error) => {
          console.error("Service worker registration failed:", error);
        });
    };

    // Registration is deferred so it never competes with the first render.
    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
