"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

/** The size and alignment a card row's leading favicon uses. */
export const ROW_FAVICON = "mt-0.5 h-4 w-4 shrink-0 rounded-sm object-contain";

/**
 * A site favicon, falling back to a globe when it cannot be loaded.
 *
 * The image comes from Google's public favicon service, so it can be blocked,
 * offline, or a stale 404 for a site that no longer exists. The fallback is
 * therefore not optional: a missing mark would read as a broken row.
 */
export function FaviconMark({ url, className = ROW_FAVICON }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) return <Globe className={cn("text-muted-foreground", className)} />;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- favicon from an external CDN
    <img src={url} alt="" className={className} onError={() => setFailed(true)} />
  );
}
