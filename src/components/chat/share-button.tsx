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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/http";

interface ShareButtonProps {
  sessionId: string;
}

export function ShareButton({ sessionId }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const enableSharing = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchJson<{ ok: boolean; shareUrl: string; shareToken: string }>(
        `/api/chat/sessions/${sessionId}/share`,
        { method: "POST" },
      );
      if (data.ok) {
        setIsShared(true);
        setShareUrl(getFullUrl(data.shareUrl));
      }
    } catch (err) {
      console.error("Failed to enable sharing:", err);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const disableSharing = useCallback(async () => {
    setIsLoading(true);
    try {
      await fetchJson(`/api/chat/sessions/${sessionId}/share`, { method: "DELETE" });
      setIsShared(false);
      setShareUrl("");
    } catch (err) {
      console.error("Failed to disable sharing:", err);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const handleToggle = async (checked: boolean) => {
    if (checked) {
      await enableSharing();
    } else {
      await disableSharing();
    }
  };

  const loadShareState = useCallback(async () => {
    try {
      const data = await fetchJson<{
        ok: boolean;
        isShared: boolean;
        shareUrl?: string;
      }>(`/api/chat/sessions/${sessionId}/share`);
      if (data.ok) {
        setIsShared(data.isShared);
        setShareUrl(data.isShared && data.shareUrl ? getFullUrl(data.shareUrl) : "");
      }
    } catch (err) {
      console.error("Failed to load share state:", err);
    }
  }, [sessionId]);

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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger>
        <span className="hover:bg-accent/60 inline-flex h-7 items-center gap-1 rounded px-1.5 text-sm transition-colors">
          <Share2 className="h-3.5 w-3.5" />
        </span>
      </DialogTrigger>
      <DialogContent className="w-full max-w-sm sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription>
            Anyone with the link can view this conversation. Tool details are hidden — commands,
            file contents, mail and calendar entries are stripped from the shared page. Viewers can
            sign in to copy it to their own account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Share this conversation</Label>
              <p className="text-muted-foreground text-xs">
                {isShared ? "Anyone with the link can view this chat" : "Sharing is disabled"}
              </p>
            </div>
            <Switch
              size="sm"
              checked={isShared}
              onCheckedChange={handleToggle}
              disabled={isLoading}
            />
          </div>

          {/* Share URL */}
          {isShared && shareUrl && (
            <div className="flex items-center gap-2">
              <Input readOnly value={shareUrl} className="font-mono text-sm" tabIndex={-1} />
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
