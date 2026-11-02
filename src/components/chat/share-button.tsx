"use client";

import { useState, useCallback } from "react";
import { Copy, CopyCheck, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fetchJson, postJson } from "@/lib/http";
import {
  DEFAULT_SHARE_ACCESS,
  SHARE_ACCESSES,
  isShareAccess,
  type ShareAccess,
} from "@/lib/chat/share-access";

interface ShareButtonProps {
  sessionId: string;
}

/** The two audiences a share link can have. */
const ACCESS_LABELS: Record<ShareAccess, string> = {
  public: "Anyone with the link",
  account: "Signed-in users",
};

const ACCESS_OPTIONS = SHARE_ACCESSES.map((value) => ({ value, label: ACCESS_LABELS[value] }));

const ACCESS_HINTS: Record<ShareAccess, string> = {
  public: "Anyone holding the link can read this chat.",
  account: "A viewer has to sign in to this instance to read this chat.",
};

export function ShareButton({ sessionId }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [access, setAccess] = useState<ShareAccess>(DEFAULT_SHARE_ACCESS);
  const [shareUrl, setShareUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadShareState = useCallback(async () => {
    try {
      const data = await fetchJson<{
        ok: boolean;
        isShared: boolean;
        shareUrl?: string;
        access: ShareAccess;
      }>(`/api/chat/sessions/${sessionId}/share`);
      if (data.ok) {
        setIsShared(data.isShared);
        setShareUrl(data.isShared && data.shareUrl ? getFullUrl(data.shareUrl) : "");
        setAccess(isShareAccess(data.access) ? data.access : DEFAULT_SHARE_ACCESS);
      }
    } catch (err) {
      console.error("Failed to load share state:", err);
    }
  }, [sessionId]);

  /** Enable, disable, or change who the link is for. */
  const saveShare = useCallback(
    async (next: { shared: boolean; access: ShareAccess }) => {
      setIsLoading(true);
      try {
        if (next.shared) {
          const data = await postJson<{ ok: boolean; shareUrl: string }>(
            `/api/chat/sessions/${sessionId}/share`,
            { access: next.access },
          );
          setShareUrl(getFullUrl(data.shareUrl));
        } else {
          await fetchJson(`/api/chat/sessions/${sessionId}/share`, { method: "DELETE" });
          setShareUrl("");
        }
        setIsShared(next.shared);
        setAccess(next.access);
      } catch (err) {
        console.error("Failed to save the share setting:", err);
        void loadShareState();
      } finally {
        setIsLoading(false);
      }
    },
    [sessionId, loadShareState],
  );

  const handleToggle = (checked: boolean) => {
    void saveShare({ shared: checked, access });
  };

  const handleAccessChange = (value: string | null) => {
    if (!isShareAccess(value)) return;
    if (isShared) {
      void saveShare({ shared: true, access: value });
    } else {
      setAccess(value);
    }
  };

  // Load current share state when dialog opens
  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (open) {
      void loadShareState();
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const activeHint = isShared ? ACCESS_HINTS[access] : "Sharing is off";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger aria-label="Share this chat">
        <span className="hover:bg-accent/60 inline-flex h-7 items-center gap-1 rounded px-1.5 text-sm transition-colors">
          <Share2 className="h-3.5 w-3.5" />
        </span>
      </DialogTrigger>
      <DialogContent className="w-full max-w-sm sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription>
            Tool details are hidden on the shared page: commands, file contents, mail and calendar
            entries are stripped from it. Viewers can sign in to copy the chat to their own account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div className="min-w-0 space-y-0.5">
              <Label>Share this conversation</Label>
              <p className="text-muted-foreground text-xs">{activeHint}</p>
            </div>
            <Switch
              size="sm"
              checked={isShared}
              onCheckedChange={handleToggle}
              disabled={isLoading}
            />
          </div>

          {/* Audience */}
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="share-access">Who can open the link</Label>
            <Select value={access} onValueChange={handleAccessChange} disabled={isLoading}>
              <SelectTrigger id="share-access">
                <SelectValue>{(value) => ACCESS_LABELS[value as ShareAccess]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ACCESS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Share URL */}
          {isShared && shareUrl && (
            <div className="flex items-center gap-2">
              <Input readOnly value={shareUrl} aria-label="Share link" className="text-sm" />
              <Button
                size="icon"
                variant="secondary"
                className="shrink-0"
                onClick={copyToClipboard}
                title="Copy link"
              >
                {copied ? <CopyCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getFullUrl(path: string): string {
  if (path.startsWith("http")) return path;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  return `${baseUrl}${path}`;
}
