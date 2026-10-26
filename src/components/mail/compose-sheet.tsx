"use client";

import { useEffect } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { EmailComposeForm } from "@/components/mail/email-compose-form";
import { useEmailCompose } from "@/hooks/use-email-compose";

interface ComposeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComposeSheet({ open, onOpenChange }: ComposeSheetProps) {
  const { formProps, loadAccounts, reset, send } = useEmailCompose();

  useEffect(() => {
    if (open) void loadAccounts();
  }, [open, loadAccounts]);

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handleSend = async () => {
    if (!(await send()).ok) return;
    close();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[560px] sm:max-w-none">
        <EmailComposeForm {...formProps} onSend={handleSend} onDiscard={close} />
      </SheetContent>
    </Sheet>
  );
}
