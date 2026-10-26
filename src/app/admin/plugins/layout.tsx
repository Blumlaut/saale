import { SectionedAreaShell } from "@/components/layout/sectioned-area-shell";
import { adminSections } from "@/lib/navigation/admin-sections";

export default function AdminPluginsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionedAreaShell areaLabel="Plugins" sections={adminSections("/admin/plugins")}>
      {children}
    </SectionedAreaShell>
  );
}
