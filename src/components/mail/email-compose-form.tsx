"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, ChevronDown, ChevronUp } from "lucide-react";
import type { EmailAccount } from "@/types/shared";

interface EmailComposeFormProps {
  accounts: EmailAccount[];
  accountId: string;
  onAccountIdChange: (id: string) => void;
  to: string;
  onToChange: (value: string) => void;
  cc: string;
  onCcChange: (value: string) => void;
  bcc: string;
  onBccChange: (value: string) => void;
  subject: string;
  onSubjectChange: (value: string) => void;
  body: string;
  onBodyChange: (value: string) => void;
  error: string;
  sending: boolean;
  onSend: () => void;
  onDiscard: () => void;
  bodyRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Extra content rendered above the body label (e.g. AI Draft button) */
  bodyHeader?: React.ReactNode;
  /** Override body textarea className */
  bodyClassName?: string;
  /** Custom header content (default: "Compose" with Send icon) */
  headerContent?: React.ReactNode;
}

export function EmailComposeForm({
  accounts,
  accountId,
  onAccountIdChange,
  to,
  onToChange,
  cc,
  onCcChange,
  bcc,
  onBccChange,
  subject,
  onSubjectChange,
  body,
  onBodyChange,
  error,
  sending,
  onSend,
  onDiscard,
  bodyRef,
  bodyHeader,
  bodyClassName = "min-h-[200px] resize-y rounded-2xl border-0 bg-muted/50 shadow-none",
  headerContent = (
    <>
      <Send className="h-4 w-4" />
      Compose
    </>
  ),
}: EmailComposeFormProps) {
  const [showOptions, setShowOptions] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border/30 flex items-center justify-between border-b px-6 pt-6 pb-4">
        <h2 className="flex items-center gap-2 text-xl leading-tight font-semibold tracking-tight">
          {headerContent}
        </h2>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-3">
          {/* From */}
          <div className="space-y-1.5">
            <Label className="text-xs">From</Label>
            <Select value={accountId} onValueChange={(v) => v && onAccountIdChange(v)}>
              <SelectTrigger className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none">
                {accounts.find((a) => a.id === accountId)?.email ?? (
                  <SelectValue placeholder="Select account" />
                )}
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter((a) => a.enabled)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* To */}
          <div className="space-y-1.5">
            <Label className="text-xs">To</Label>
            <Input
              value={to}
              onChange={(e) => onToChange(e.target.value)}
              placeholder="recipient@example.com"
              className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
            />
          </div>

          {/* CC / BCC toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-6 px-2 text-xs"
            onClick={() => setShowOptions(!showOptions)}
          >
            {showOptions ? (
              <ChevronUp className="mr-1 h-3 w-3" />
            ) : (
              <ChevronDown className="mr-1 h-3 w-3" />
            )}
            {showOptions ? "Hide" : "Show"} Cc/Bcc
          </Button>

          {showOptions && (
            <>
              {/* CC */}
              <div className="space-y-1.5">
                <Label className="text-xs">Cc</Label>
                <Input
                  value={cc}
                  onChange={(e) => onCcChange(e.target.value)}
                  placeholder="cc@example.com"
                  className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                />
              </div>

              {/* BCC */}
              <div className="space-y-1.5">
                <Label className="text-xs">Bcc</Label>
                <Input
                  value={bcc}
                  onChange={(e) => onBccChange(e.target.value)}
                  placeholder="bcc@example.com"
                  className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                />
              </div>
              <Separator className="border-border/30" />
            </>
          )}

          {/* Subject */}
          <div className="space-y-1.5">
            <Label className="text-xs">Subject</Label>
            <Input
              value={subject}
              onChange={(e) => onSubjectChange(e.target.value)}
              placeholder="Email subject"
              className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
            />
          </div>

          {/* Body */}
          <div className="space-y-1.5">
            {bodyHeader && <div className="flex items-center justify-between">{bodyHeader}</div>}
            {!bodyHeader && <Label className="text-xs">Body</Label>}
            <Textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              placeholder="Write your message..."
              className={bodyClassName}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-xl px-4 py-2.5 text-sm">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-border/30 border-t px-6 py-4">
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            className="liquid-glass-pill h-9 rounded-full text-xs font-medium"
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button
            className="liquid-glass-accent h-9 gap-2 rounded-full text-xs font-medium"
            onClick={onSend}
            disabled={sending || !to.trim() || !accountId}
          >
            {sending ? (
              "Sending..."
            ) : (
              <>
                <Send className="h-3.5 w-3.5" /> Send
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
