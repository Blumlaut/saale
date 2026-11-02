import { requireAdminSection } from "@/lib/permissions/guards";
import { SectionedAreaShell } from "@/components/layout/sectioned-area-shell";
import { adminSections } from "@/lib/navigation/admin-sections";

export default async function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSection("settings");
  return (
    <SectionedAreaShell areaLabel="Settings" sections={adminSections("/admin/settings")}>
      {children}
    </SectionedAreaShell>
  );
}
