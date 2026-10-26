"use client";

import { Page, PageScroll } from "@/components/layout/page";
import { ProviderConnections } from "@/components/providers/provider-connections";

export default function AdminModelProvidersPage() {
  return (
    <Page className="gap-0">
      <PageScroll>
        <ProviderConnections scope="global" />
      </PageScroll>
    </Page>
  );
}
