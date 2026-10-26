import { Page, PageScroll } from "@/components/layout/page";
import { IntegrationsSection } from "../sections/integrations-section";

export default function SettingsIntegrationsPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <IntegrationsSection />
      </PageScroll>
    </Page>
  );
}
