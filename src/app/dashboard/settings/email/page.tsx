import { Page, PageScroll } from "@/components/layout/page";
import { EmailSection } from "../sections/email-section";

export default function SettingsEmailPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <EmailSection />
      </PageScroll>
    </Page>
  );
}
