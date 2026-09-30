"use client";

import { useState } from "react";
import { Inbox } from "@/components/mail/inbox";
import { ComposeSheet } from "@/components/mail/compose-sheet";
import { AccountSheet } from "@/components/mail/account-sheet";
import { Page } from "@/components/layout/page";

export default function MailPage() {
  const [showCompose, setShowCompose] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);

  return (
    <Page className="gap-0">
      {/* Inbox — fills remaining height, scrolls internally */}
      <div className="min-h-0 flex-1">
        <Inbox
          onCompose={() => setShowCompose(true)}
          onAddAccount={() => setShowAddAccount(true)}
        />
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
