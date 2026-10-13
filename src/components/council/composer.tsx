"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { postJson } from "@/lib/http";
import { MAX_MESSAGE_LENGTH } from "@/lib/council/config";
import type { CouncilMemberView } from "@/types/council";
import { Loader2, Send } from "lucide-react";

export interface ComposerProps {
  councilId: string;
  members: CouncilMemberView[];
  /** The room is working — the message joins the run in flight. */
  running: boolean;
  /** The room paused on a question addressed to the owner. */
  waiting: boolean;
  /** Called after a message is accepted, so the room refetches. */
  onPosted: () => void;
}

/**
 * The owner's composer.
 *
 * Sending a message always starts (or joins) a run: the owner speaking into the
 * room means "the council should act on this". A message posted while a run is
 * in flight is absorbed by that run and wakes whoever it addresses, so this
 * steers a working council rather than waiting for it to finish.
 */
export function Composer({ councilId, members, running, waiting, onPosted }: ComposerProps) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const enabledMembers = members.filter((member) => member.enabled);
  const tooLong = content.length > MAX_MESSAGE_LENGTH;

  const submit = async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || tooLong) return;

    setSending(true);
    setError("");
    try {
      await postJson(`/api/council/${councilId}/messages`, { content: trimmed, startRun: true });
      setContent("");
      onPosted();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not post the message";
      console.error("Failed to post a council room message:", err);
      setError(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t px-4 py-3 md:px-6">
      <div className="flex items-end gap-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            waiting
              ? "Answer the room to resume the run…"
              : running
                ? "Steer the council — a message wakes whoever it addresses…"
                : "Give the council something to do…"
          }
          rows={2}
          className="max-h-40 min-h-[48px] min-w-0 flex-1 resize-y"
        />
        <Button
          size="icon"
          className="h-10 w-10 shrink-0"
          disabled={sending || content.trim().length === 0 || tooLong}
          onClick={() => void submit()}
          aria-label="Send message"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground text-[11px]">
          Address members with @name, everyone with @all, or the owner with @user.
        </span>
        {enabledMembers.length > 0 && (
          <span className="text-muted-foreground flex flex-wrap items-center gap-1 font-mono text-[11px]">
            {enabledMembers.map((member) => (
              <Button
                key={member.id}
                type="button"
                variant="ghost"
                size="xs"
                className="h-auto px-1 py-0.5 font-mono text-[11px] font-normal"
                onClick={() =>
                  setContent(
                    (prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}@${member.name} `,
                  )
                }
              >
                @{member.name}
              </Button>
            ))}
          </span>
        )}
      </div>

      {error && <p className="text-destructive mt-1.5 text-xs">{error}</p>}
      {tooLong && (
        <p className="text-destructive mt-1.5 text-xs">
          Message is too long ({content.length}/{MAX_MESSAGE_LENGTH} characters).
        </p>
      )}
    </div>
  );
}
