"use client";

import { useState } from "react";
import { Page } from "@/components/layout/page";
import { Inbox } from "@/components/mail/inbox";
import { ComposeSheet } from "@/components/mail/compose-sheet";
import { AccountSheet } from "@/components/mail/account-sheet";

export default function MailPage() {
  const [showCompose, setShowCompose] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1 overflow-hidden">
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
