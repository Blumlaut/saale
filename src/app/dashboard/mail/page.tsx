"use client";

import { useState } from "react";
import { Inbox } from "@/components/mail/inbox";
import { ComposeSheet } from "@/components/mail/compose-sheet";
import { AccountSheet } from "@/components/mail/account-sheet";
import { Button } from "@/components/ui/button";
import { MailPlus, Plus } from "lucide-react";

export default function MailPage() {
  const [showCompose, setShowCompose] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Mail</h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">Manage your inbox</p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Inbox */}
      <Inbox />

      {/* Sheets */}
      <ComposeSheet open={showCompose} onOpenChange={setShowCompose} />
      <AccountSheet
        open={showAddAccount}
        onOpenChange={setShowAddAccount}
        onSuccess={() => {
          window.dispatchEvent(new CustomEvent("mail:refresh"));
        }}
      />
    </div>
  );
}
