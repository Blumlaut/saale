import { SectionedAreaShell } from "@/components/layout/sectioned-area-shell";
import { sidebarNavItem } from "@/lib/navigation/sidebar-nav";

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionedAreaShell areaLabel="Jobs" sections={sidebarNavItem("jobs").sections ?? []}>
      {children}
    </SectionedAreaShell>
  );
}
