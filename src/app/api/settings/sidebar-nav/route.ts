import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { SIDEBAR_NAV_ITEM_IDS, normalizeSidebarNav } from "@/lib/navigation/sidebar-nav";

const sidebarNavEntrySchema = z.object({
  id: z.enum(SIDEBAR_NAV_ITEM_IDS),
  hidden: z.boolean(),
});

const patchBodySchema = z.object({
  /**
   * Ordered layout. `null` clears the customization (default order, everything
   * visible). At least one item must stay visible — a sidebar with nothing in it
   * leaves no way back into the app.
   */
  items: z
    .array(sidebarNavEntrySchema)
    .max(SIDEBAR_NAV_ITEM_IDS.length)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "duplicate sidebar items",
    )
    .refine(
      (items) => items.some((item) => !item.hidden) || items.length === 0,
      "at least one sidebar item must stay visible",
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
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch(() => undefined);
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sidebar layout" }, { status: 400 });
  }

  const { items } = parsed.data;
  // null clears the column; normalization drops unknown/duplicate ids so a stale
  // client can't persist a layout the nav can't render.
  const sidebarItems: Prisma.InputJsonValue | typeof Prisma.DbNull =
    items === null
      ? Prisma.DbNull
      : normalizeSidebarNav(items).map((entry) => ({ id: entry.id, hidden: entry.hidden }));

  const settings = await prisma.appSettings.upsert({
    where: { userId: authResult.user.id },
    create: { userId: authResult.user.id, sidebarItems },
    update: { sidebarItems },
  });

  return NextResponse.json({ items: normalizeSidebarNav(settings.sidebarItems) });
}
