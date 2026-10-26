import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildBrandingCss, normalizeThemeColors } from "@/lib/branding/theme";
import { readAdminSettings } from "@/lib/settings/update";

/**
 * GET /api/branding/theme. The accent overrides as a stylesheet.
 *
 * Linked from the root layout, so it is served to signed-out pages too: the
 * colours are branding, and nothing here is per-account. The `ETag` is the
 * settings row's `updatedAt`, which makes a save reach every open page on its
 * next load without shipping a stale sheet.
 */
export async function GET(request: NextRequest) {
  const settings = await readAdminSettings();
  const etag = `"branding-${settings?.updatedAt.getTime() ?? 0}"`;

  const headers = {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: etag,
  };

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const css = buildBrandingCss(normalizeThemeColors(settings?.themeColors));
  return new NextResponse(`/* Saale branding overrides */\n${css}\n`, { headers });
}
