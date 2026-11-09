import { Page, PageScroll } from "@/components/layout/page";
import { GithubAppPanel } from "@/components/admin/github-app-panel";

export default function AdminSettingsGithubPage() {
  return (
    <Page>
      <PageScroll className="space-y-6">
        <GithubAppPanel />
      </PageScroll>
    </Page>
  );
}
