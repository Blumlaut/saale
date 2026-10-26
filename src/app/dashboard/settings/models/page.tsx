import { Page, PageScroll } from "@/components/layout/page";
import { ModelsSection } from "../sections/models-section";

export default function SettingsModelsPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <ModelsSection />
      </PageScroll>
    </Page>
  );
}
