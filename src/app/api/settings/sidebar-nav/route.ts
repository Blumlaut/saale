import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { SIDEBAR_NAV_ITEM_IDS, normalizeSidebarNav } from "@/lib/navigation/sidebar-nav";
import { applyUserSettingsPatch, SettingsError } from "@/lib/settings/update";

const sidebarNavEntrySchema = z.object({
  id: z.enum(SIDEBAR_NAV_ITEM_IDS),
  hidden: z.boolean(),
});

const patchBodySchema = z.object({
  /**
   * Ordered layout. `null` clears the customization (default order, everything
   * visible). Any item may be flagged hidden — normalization forces the pinned
   * ones (Settings) back to visible, so the sidebar can never end up empty.
   */
  items: z
    .array(sidebarNavEntrySchema)
    .max(SIDEBAR_NAV_ITEM_IDS.length)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "duplicate sidebar items",
    )
    .nullable(),
});

/**
 * GET /api/settings/sidebar-nav — Get the user's sidebar layout
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const settings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { sidebarItems: true },
  });

  return NextResponse.json({ items: normalizeSidebarNav(settings?.sidebarItems) });
}

/**
 * PATCH /api/settings/sidebar-nav — Save the user's sidebar layout
 *
 * The layout lands in `AppSettings.sidebarItems` through the settings registry,
 * so this route never writes the table directly and the value is normalized the
 * same way `settings_set("sidebar.<item>.hidden", …)` normalizes it.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch(() => undefined);
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sidebar layout" }, { status: 400 });
  }

  try {
    // `null` clears the column; the registry drops unknown/duplicate ids so a
    // stale client can't persist a layout the nav can't render.
    const settings = await applyUserSettingsPatch(authResult.user.id, {
      sidebarItems: parsed.data.items,
    });
    return NextResponse.json({ items: normalizeSidebarNav(settings.sidebarItems) });
  } catch (err) {
    if (err instanceof SettingsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to save sidebar navigation layout:", err);
    return NextResponse.json({ error: "Failed to save sidebar layout" }, { status: 500 });
  }
}
