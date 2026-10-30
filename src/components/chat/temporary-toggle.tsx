"use client";

import { Ghost } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface TemporaryToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Temporary-chat mode control. Desktop: pill with a switch. Below `sm` an
 * icon button, so the chat header row still fits narrow screens.
 */
export function TemporaryToggle({ checked, onChange }: TemporaryToggleProps) {
  return (
    <>
      <div
        className={
          "hidden items-center gap-1.5 rounded-full px-2 py-1 transition-colors sm:flex " +
          (checked ? "bg-accent/70" : "bg-muted/50 hover:bg-accent/60")
        }
      >
        <Ghost
          className={
            "h-3.5 w-3.5 transition-colors " +
            (checked ? "text-foreground" : "text-muted-foreground")
          }
        />
        <Switch
          size="sm"
          checked={checked}
          onCheckedChange={onChange}
          title="Temporary chat. auto-deleted on close"
        />
      </div>
      <Button
        variant="ghost"
        size="icon"
        className={
          "h-8 w-8 shrink-0 sm:hidden " +
          (checked ? "bg-accent/70 text-foreground" : "text-muted-foreground")
        }
        onClick={() => onChange(!checked)}
        title="Temporary chat. auto-deleted on close"
      >
        <Ghost className="h-4 w-4" />
      </Button>
    </>
  );
}
