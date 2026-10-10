"use client";

import { useState } from "react";
import { Inbox as InboxIcon, Users } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Page, PageTabStrip } from "@/components/layout/page";
import { Inbox } from "@/components/mail/inbox";
import { ComposeSheet } from "@/components/mail/compose-sheet";
import { AccountSheet } from "@/components/mail/account-sheet";
import { ContactsPanel } from "@/components/contacts/contacts-panel";

export default function MailPage() {
  const [activeTab, setActiveTab] = useState("inbox");
  const [showCompose, setShowCompose] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);

  return (
    <Page className="gap-0">
      {/* Tabs — strip pinned, content fills remaining height */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <PageTabStrip className="shrink-0">
          <TabsList>
            <TabsTrigger value="inbox" className="gap-2">
              <InboxIcon className="h-4 w-4" />
              Inbox
            </TabsTrigger>
            <TabsTrigger value="contacts" className="gap-2">
              <Users className="h-4 w-4" />
              Contacts
            </TabsTrigger>
          </TabsList>
        </PageTabStrip>

        <TabsContent value="inbox" className="min-h-0 flex-1 overflow-hidden">
          <Inbox
            onCompose={() => setShowCompose(true)}
            onAddAccount={() => setShowAddAccount(true)}
          />
        </TabsContent>

        <TabsContent value="contacts" className="min-h-0 flex-1 overflow-hidden">
          <ContactsPanel />
        </TabsContent>
      </Tabs>

      {/* Sheets */}
      <ComposeSheet open={showCompose} onOpenChange={setShowCompose} />
      <AccountSheet
        open={showAddAccount}
        onOpenChange={setShowAddAccount}
        onSuccess={() => {
          window.dispatchEvent(new CustomEvent("mail:refresh"));
        }}
      />
    </Page>
  );
}
