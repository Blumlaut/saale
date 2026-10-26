import { Page, PageScroll } from "@/components/layout/page";
import { NotificationsSection } from "../sections/notifications-section";

export default function SettingsNotificationsPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <NotificationsSection />
      </PageScroll>
    </Page>
  );
}
