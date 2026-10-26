import { Page, PageScroll } from "@/components/layout/page";
import { MemoriesSection } from "../sections/memories-section";

export default function SettingsMemoriesPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <MemoriesSection />
      </PageScroll>
    </Page>
  );
}
