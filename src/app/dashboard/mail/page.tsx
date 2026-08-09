"use client";

import { useState } from "react";
import { Inbox } from "@/components/mail/inbox";
import { ComposeSheet } from "@/components/mail/compose-sheet";
import { AccountSheet } from "@/components/mail/account-sheet";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/layout/page";
import { MailPlus, Plus } from "lucide-react";

export default function MailPage() {
  const [showCompose, setShowCompose] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);

  return (
    <Page className="gap-0">
      {/* Header — pinned, never scrolls */}
      <PageHeader
        title="Mail"
        description="Manage your inbox"
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              className="liquid-glass-pill h-8 w-8 rounded-full md:h-9 md:w-auto md:gap-3 md:px-3"
              onClick={() => setShowAddAccount(true)}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden md:inline">Add Account</span>
            </Button>
            <Button
              className="liquid-glass-accent h-8 w-8 rounded-full md:h-9 md:w-auto md:gap-3 md:px-3"
              size="icon"
              onClick={() => setShowCompose(true)}
            >
              <MailPlus className="h-4 w-4" />
              <span className="hidden md:inline">Compose</span>
            </Button>
          </>
        }
      />

      {/* Inbox — fills remaining height, scrolls internally */}
      <div className="min-h-0 flex-1">
        <Inbox />
      </div>

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
