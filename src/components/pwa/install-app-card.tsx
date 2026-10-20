"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Check, Download, Share } from "lucide-react";

/** Chromium's install prompt event. not part of lib.dom, so it is declared here. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallState = "checking" | "installed" | "installable" | "ios" | "unavailable";

function isStandalone(): boolean {
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone === true;
}

/** iPadOS 13+ reports a desktop user agent, so touch points are the tell. */
function isIos(): boolean {
  const { userAgent, maxTouchPoints } = window.navigator;
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/**
 * "Install Saale" card.
 *
 * Lives in Settings rather than the app shell: an install banner would spend
 * vertical space on every mobile page. the exact trade-off AGENTS.md rejects
 * for page titles. and would put the mobile layout guardrails at the mercy of
 * when the browser decides to fire `beforeinstallprompt`.
 *
 * Renders nothing when the current browser offers no install path at all.
 */
export function InstallAppCard() {
  const [state, setState] = useState<InstallState>("checking");
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) {
      setState("installed");
      return;
    }

    const onBeforeInstallPrompt = (event: Event) => {
      // Hold the event so install can be triggered from our own button.
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
      setState("installable");
    };
    const onInstalled = () => {
      setPromptEvent(null);
      setState("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // Safari never fires `beforeinstallprompt`. it needs manual instructions.
    setState(isIos() ? "ios" : "unavailable");

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) return;

    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    setPromptEvent(null);
    if (outcome === "accepted") setState("installed");
  };

  if (state === "checking" || state === "unavailable") return null;

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Download className="h-5 w-5" />
            Install
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Run Saale in its own window, with its own icon and home screen shortcut.
          </p>
        </div>

        {state === "installed" && (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Check className="text-primary h-4 w-4 shrink-0" />
            Saale is installed on this device.
          </p>
        )}

        {state === "installable" && (
          <Button onClick={install}>
            <Download />
            Install Saale
          </Button>
        )}

        {state === "ios" && (
          <p className="text-muted-foreground text-sm">
            Tap the share button
            <Share className="mx-1 inline h-4 w-4 align-text-bottom" />
            then choose <span className="text-foreground font-medium">Add to Home Screen</span>.
          </p>
        )}
      </GlassPanelContent>
    </GlassPanel>
  );
}
