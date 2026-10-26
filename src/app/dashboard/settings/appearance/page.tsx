import { Page, PageScroll } from "@/components/layout/page";
import { AppearanceSection } from "../sections/appearance-section";

export default function SettingsAppearancePage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <AppearanceSection />
      </PageScroll>
    </Page>
  );
}
