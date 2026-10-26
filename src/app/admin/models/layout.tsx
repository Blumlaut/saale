import { SectionedAreaShell } from "@/components/layout/sectioned-area-shell";
import { adminSections } from "@/lib/navigation/admin-sections";

export default function AdminModelsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionedAreaShell areaLabel="Models" sections={adminSections("/admin/models")}>
      {children}
    </SectionedAreaShell>
  );
}
