import { requireAnyAdminSection } from "@/lib/permissions/guards";
import { SectionedAreaShell } from "@/components/layout/sectioned-area-shell";
import { visibleAdminSections } from "@/lib/navigation/admin-sections";

/** Sections stand on a slice each, so the area opens for any of them. */
const AREA_ACTIONS = ["users", "workspaces", "usage"] as const;

export default async function AdminUsersLayout({ children }: { children: React.ReactNode }) {
  const access = await requireAnyAdminSection(AREA_ACTIONS);
  return (
    <SectionedAreaShell
      areaLabel="Users"
      sections={visibleAdminSections("/admin/users", access.permissions)}
    >
      {children}
    </SectionedAreaShell>
  );
}
