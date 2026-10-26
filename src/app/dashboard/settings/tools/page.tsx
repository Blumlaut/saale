import { Page, PageScroll } from "@/components/layout/page";
import { ToolsSection } from "../sections/tools-section";

export default function SettingsToolsPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <ToolsSection />
      </PageScroll>
    </Page>
  );
}
