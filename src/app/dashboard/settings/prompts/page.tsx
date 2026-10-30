import { Page, PageScroll } from "@/components/layout/page";
import { PromptsSection } from "../sections/prompts-section";

export default function SettingsPromptsPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <PromptsSection />
      </PageScroll>
    </Page>
  );
}
