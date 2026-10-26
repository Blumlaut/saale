"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The URL the uploaded avatar is served from (a 404 while none is set). */
const AVATAR_URL = "/api/branding/avatar";

/**
 * Saale's own mark: the accent `>` an admin can replace with an uploaded image.
 *
 * The mark doubles as the loading and missing state. The image arrives after
 * the mark has painted, and an instance without an upload answers 404, which
 * leaves the mark in place.
 *
 * @param className sizing and shape of the box
 * @param markClassName size of the `>` inside it
 * @param version busts the cached image after a new upload
 */
export function AgentAvatar({
  className,
  markClassName = "h-4 w-4",
  alt = "",
  version = "",
}: {
  className?: string;
  markClassName?: string;
  alt?: string;
  version?: string;
}) {
  const [showImage, setShowImage] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const src = version ? `${AVATAR_URL}?v=${encodeURIComponent(version)}` : AVATAR_URL;

  return (
    <span className={cn("relative flex items-center justify-center overflow-hidden", className)}>
      {!loaded && <ChevronRight className={cn("text-primary", markClassName)} aria-hidden />}
      {showImage && (
        // eslint-disable-next-line @next/next/no-img-element -- local upload, sized by its box
        <img
          src={src}
          alt={alt}
          className={cn(
            "absolute inset-0 h-full w-full object-cover",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setShowImage(false)}
        />
      )}
    </span>
  );
}
