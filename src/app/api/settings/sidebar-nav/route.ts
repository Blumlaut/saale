import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  SIDEBAR_NAV_ITEM_IDS,
  normalizeSidebarNav,
  type SidebarNavEntry,
  type SidebarNavItemId,
} from "@/lib/navigation/sidebar-nav";
import { isCouncilEnabled } from "@/lib/council/flag";
import { loadUserFeatures } from "@/lib/permissions/feature-access";
import { FEATURES, FEATURE_DEFINITIONS } from "@/lib/permissions/features";
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
 * Items this user may not open, whatever their stored layout says.
 *
 * The registry describes how an item renders; only the route that serves the
 * layout knows whether this particular user may use it. Filtering here — rather
 * than in each nav component — keeps the sidebar and the settings editor
 * offering the same list, and an item whose page cannot be opened is never
 * offered as a toggle.
 */
async function unavailableNavIds(userId: string): Promise<SidebarNavItemId[]> {
  const features = await loadUserFeatures(userId);
  const unavailable: SidebarNavItemId[] = [];
  for (const key of FEATURES) {
    const navId = FEATURE_DEFINITIONS[key].navId;
    if (!navId) continue;
    // The council also has a deployment flag of its own.
    const enabled = key === "council" ? features[key] && isCouncilEnabled() : features[key];
    if (!enabled) unavailable.push(navId);
  }
  return unavailable;
}

function restrict(entries: SidebarNavEntry[], unavailable: SidebarNavItemId[]): SidebarNavEntry[] {
  if (unavailable.length === 0) return entries;
  const excluded = new Set(unavailable);
  return entries.filter((entry) => !excluded.has(entry.id));
}

/**
 * GET /api/settings/sidebar-nav — Get the user's sidebar layout
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const [settings, unavailable] = await Promise.all([
    prisma.appSettings.findUnique({
      where: { userId: authResult.user.id },
      select: { sidebarItems: true },
    }),
    unavailableNavIds(authResult.user.id),
  ]);

  return NextResponse.json({
    items: restrict(normalizeSidebarNav(settings?.sidebarItems), unavailable),
  });
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
    const unavailable = await unavailableNavIds(authResult.user.id);
    return NextResponse.json({
      items: restrict(normalizeSidebarNav(settings.sidebarItems), unavailable),
    });
  } catch (err) {
    if (err instanceof SettingsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to save sidebar navigation layout:", err);
    return NextResponse.json({ error: "Failed to save sidebar layout" }, { status: 500 });
  }
}
