import { Page, PageScroll } from "@/components/layout/page";

/**
 * A settings route whose section brings no scroll frame of its own: the page
 * scrolls, the section stacks its panels inside.
 */
export function SettingsPage({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <PageScroll className="space-y-6">{children}</PageScroll>
    </Page>
  );
}
