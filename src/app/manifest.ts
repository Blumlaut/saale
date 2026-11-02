import type { MetadataRoute } from "next";

import brand from "@/lib/pwa/brand.json";
import { getWorkspaceName } from "@/lib/branding/workspace";

/**
 * Web app manifest. served at `/manifest.webmanifest` and linked from `<head>`
 * automatically by the App Router file convention.
 *
 * `background_color` is the dark console background rather than a
 * scheme-dependent value: the manifest cannot express both schemes, and the
 * icons are drawn on the same dark ground, so the install splash stays
 * consistent. The in-browser chrome colour is scheme-aware instead. see the
 * `viewport` export in `src/app/layout.tsx`.
 */
// The name comes from the database, so the manifest is rendered per request
// rather than baked into the build.
export const dynamic = "force-dynamic";

export const revalidate = 0;

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const name = await getWorkspaceName();

  return {
    id: "/",
    name,
    short_name: name,
    description: brand.description,
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: brand.backgroundColor,
    theme_color: brand.backgroundColor,
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Chat", url: "/dashboard/chat" },
      { name: "Mail", url: "/dashboard/mail" },
      { name: "Calendar", url: "/dashboard/calendar" },
      { name: "Jobs", url: "/dashboard/jobs" },
    ],
  };
}
