import { Page, PageScroll } from "@/components/layout/page";
import { CalendarSection } from "../sections/calendar-section";

export default function SettingsCalendarPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <CalendarSection />
      </PageScroll>
    </Page>
  );
}
