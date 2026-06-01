"use client";

import { useState } from "react";
import { Inbox } from "@/components/mail/inbox";
import { ComposeDialog } from "@/components/mail/compose-dialog";
import { AccountDialog } from "@/components/mail/account-dialog";
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
            className="h-8 w-8 md:h-9 md:w-auto md:px-3"
            onClick={() => setShowAddAccount(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden md:inline">Add Account</span>
          </Button>
          <Button
            variant="default"
            size="icon"
            className="h-8 w-8 md:h-9 md:w-auto md:px-3"
            onClick={() => setShowCompose(true)}
          >
            <MailPlus className="h-4 w-4" />
            <span className="hidden md:inline">Compose</span>
          </Button>
        </div>
      </div>

      {/* Inbox */}
      <Inbox />

      {/* Dialogs */}
      <ComposeDialog open={showCompose} onOpenChange={setShowCompose} />
      <AccountDialog
        open={showAddAccount}
        onOpenChange={setShowAddAccount}
        onSuccess={() => {
          window.dispatchEvent(new CustomEvent("mail:refresh"));
        }}
      />
    </div>
  );
}
