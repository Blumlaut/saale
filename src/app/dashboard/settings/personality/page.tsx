import { Page, PageScroll } from "@/components/layout/page";
import { PersonalitySection } from "../sections/personality-section";

export default function SettingsPersonalityPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <PersonalitySection />
      </PageScroll>
    </Page>
  );
}
