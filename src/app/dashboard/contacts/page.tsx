"use client";

import { Page } from "@/components/layout/page";
import { ContactsPanel } from "@/components/contacts/contacts-panel";

export default function MailContactsPage() {
  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1 overflow-hidden">
        <ContactsPanel />
      </div>
    </Page>
  );
}
