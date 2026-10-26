import { Page, PageScroll } from "@/components/layout/page";
import { SecuritySection } from "../sections/security-section";

export default function SettingsSecurityPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <SecuritySection />
      </PageScroll>
    </Page>
  );
}
