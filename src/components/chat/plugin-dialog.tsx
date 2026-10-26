"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Puzzle } from "lucide-react";
import type { PluginDialogData } from "./types";

/**
 * A dialog a plugin opened through Pi's `ctx.ui`.
 *
 * The run is blocked until it is answered. The buttons answer it and the
 * plugin gets Pi's own values back, `undefined`/`false`, exactly as a terminal
 * dialog would give it. "Not now" hides the dialog behind the alert row.
 */
export function PluginDialog({
  sessionId,
  dialog,
  onSettled,
  onHide,
}: {
  sessionId: string;
  dialog: PluginDialogData;
  /** Called once the answer (or the cancellation) reached the server. */
  onSettled: (id: string) => void;
  /** Dismissed without deciding: the dialog stays pending behind the alert row. */
  onHide: () => void;
}) {
  const [text, setText] = useState(dialog.prefill ?? "");
  const [busy, setBusy] = useState(false);

  // A dialog's own state belongs to its id: the next one starts fresh.
  useEffect(() => {
    setText(dialog.prefill ?? "");
    setBusy(false);
  }, [dialog.id, dialog.prefill]);

  const answer = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/chat/sessions/${sessionId}/plugin-ui`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: dialog.id, ...body }),
      });
      if (!response.ok && response.status !== 404) {
        console.error("Plugin dialog answer failed:", await response.text());
      }
    } catch (err) {
      console.error("Plugin dialog answer failed:", err);
    } finally {
      onSettled(dialog.id);
    }
  };

  const cancel = () => void answer({ cancelled: true });

  return (
    // Controlled open: Escape and the backdrop leave the dialog alone. The
    // run is blocked either way, so hiding it is a button, not an accident.
    <Dialog open>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-md"
        // The plugin's answer is the only way out besides cancelling.
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 pr-6 text-base">
            <Puzzle className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{dialog.title}</span>
          </DialogTitle>
          <DialogDescription className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>A plugin is waiting for your answer before it can continue.</span>
          </DialogDescription>
        </DialogHeader>

        {dialog.message && (
          <p className="text-sm break-words whitespace-pre-wrap">{dialog.message}</p>
        )}

        {dialog.kind === "select" && (
          <div className="flex flex-col gap-1.5">
            {(dialog.options ?? []).map((option) => (
              <Button
                key={option}
                variant="secondary"
                className="h-auto min-h-9 justify-start px-3 py-2 text-left"
                disabled={busy}
                onClick={() => void answer({ value: option })}
              >
                <span className="break-words">{option}</span>
              </Button>
            ))}
            <Button variant="ghost" size="sm" className="justify-start" onClick={onHide}>
              Not now
            </Button>
          </div>
        )}

        {dialog.kind === "confirm" && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={busy} onClick={onHide}>
              Not now
            </Button>
            <Button variant="secondary" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void answer({ confirmed: true })}>
              Confirm
            </Button>
          </div>
        )}

        {(dialog.kind === "input" || dialog.kind === "editor") && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void answer({ value: text });
            }}
          >
            {dialog.kind === "input" ? (
              <Input
                autoFocus
                value={text}
                placeholder={dialog.placeholder ?? ""}
                onChange={(event) => setText(event.target.value)}
              />
            ) : (
              <Textarea
                autoFocus
                rows={6}
                value={text}
                placeholder={dialog.placeholder ?? ""}
                className="font-mono text-xs"
                onChange={(event) => setText(event.target.value)}
              />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" disabled={busy} onClick={onHide}>
                Not now
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Send
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
