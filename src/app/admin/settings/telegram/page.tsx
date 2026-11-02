import { Page, PageScroll } from "@/components/layout/page";
import { TelegramBotPanel } from "@/components/admin/telegram-bot-panel";

export default function AdminSettingsTelegramPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <TelegramBotPanel />
      </PageScroll>
    </Page>
  );
}
