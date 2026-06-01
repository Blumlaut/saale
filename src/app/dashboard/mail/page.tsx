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
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            Mail
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your inbox
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddAccount(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Account
          </Button>
          <Button variant="default" size="sm" onClick={() => setShowCompose(true)}>
            <MailPlus className="mr-2 h-4 w-4" />
            Compose
          </Button>
        </div>
      </div>

      {/* Inbox */}
      <Inbox />

      {/* Dialogs */}
      <ComposeDialog
        open={showCompose}
        onOpenChange={setShowCompose}
      />
      <AccountDialog
        open={showAddAccount}
        onOpenChange={setShowAddAccount}
        onSuccess={() => {
          // Refresh accounts
        }}
      />
    </div>
  );
}
