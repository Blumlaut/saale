"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  Monitor,
  MoreVertical,
  PlugZap,
  Power,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROW_ACTION } from "@/lib/utils";
import { DEVICE_GROUP_LABELS } from "@/lib/devices/shared";
import type { DesktopDevice, DesktopDownload } from "@/hooks/use-desktop-devices";
import { IntegrationBox, type IntegrationBoxInfo } from "./integration-box";

const DESKTOP_BOX: IntegrationBoxInfo = {
  name: "This computer",
  description: "Let a chat use your screen, mouse and keyboard",
  icon: Monitor,
  color: "text-orange-500",
};

/** Where a device is and what it offers, in one muted line. */
function describe(device: DesktopDevice): string {
  const where = device.platform === "linux" ? device.session : device.platform;
  const groups = device.capabilities.map((group) => DEVICE_GROUP_LABELS[group].toLowerCase());
  const parts = [where, ...groups];
  return parts.filter(Boolean).join(" · ");
}

/**
 * The desktop agent box on the Integrations tab.
 *
 * A paired computer is not a remote server: the agent dials out to this
 * instance, and a chat only reaches the machine it was started from. That is
 * why the box talks about "the computer this chat is on" rather than a list of
 * machines the agent may touch.
 */
export function DesktopCard({
  devices,
  loading,
  revokingId,
  browserDeviceId,
  onConnect,
  onRevoke,
  onUseInBrowser,
}: {
  devices: DesktopDevice[];
  loading: boolean;
  revokingId: string | null;
  /** The device chats started in this browser claim. */
  browserDeviceId: string | null;
  onConnect: () => void;
  onRevoke: (deviceId: string) => void;
  onUseInBrowser: (deviceId: string | null) => void;
}) {
  const connected = devices.filter((device) => device.connected).length;

  return (
    <IntegrationBox
      manifest={DESKTOP_BOX}
      connected={devices.length > 0}
      badges={
        devices.length > 0 ? (
          <Badge variant="outline" className="rounded-full">
            {connected > 0 ? `${connected} online` : "offline"}
          </Badge>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking
          </div>
        ) : devices.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Install the agent on a computer and claim it here. A chat can use that computer while
            its newest message came from it.
          </p>
        ) : (
          <ul className="space-y-1">
            {devices.map((device) => (
              <li key={device.id} className="group flex items-center gap-2 py-1">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    device.connected ? "bg-emerald-500" : "bg-muted-foreground/40"
                  }`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {device.name}
                    {device.id === browserDeviceId && (
                      <Badge variant="secondary" className="ml-2 rounded-full align-middle">
                        this browser
                      </Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">{describe(device)}</p>
                  {device.recent.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {device.recent.map((call) => (
                        <li
                          key={`${call.tool}-${call.createdAt}`}
                          className="text-muted-foreground truncate font-mono text-[11px]"
                        >
                          <span
                            className={
                              call.outcome === "ok" ? "text-emerald-600/80" : "text-destructive"
                            }
                          >
                            {call.outcome === "ok" ? "·" : "!"}
                          </span>{" "}
                          {call.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className={ROW_ACTION}
                        aria-label={`Actions for ${device.name}`}
                        disabled={revokingId === device.id}
                      >
                        {revokingId === device.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MoreVertical className="h-4 w-4" />
                        )}
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        onUseInBrowser(device.id === browserDeviceId ? null : device.id)
                      }
                    >
                      <Square className="mr-2 h-4 w-4" />
                      {device.id === browserDeviceId
                        ? "Stop using in this browser"
                        : "Use in this browser"}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onRevoke(device.id)}>
                      <Power className="mr-2 h-4 w-4" />
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}

        <Button variant="secondary" className="h-9 w-full text-xs font-medium" onClick={onConnect}>
          <PlugZap className="mr-2 h-3.5 w-3.5" />
          {devices.length > 0 ? "Connect another computer" : "Connect a computer"}
        </Button>
      </div>
    </IntegrationBox>
  );
}

/** An explanatory line where the panel cannot offer something. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted text-muted-foreground rounded-2xl border-0 px-4 py-3 text-sm">
      {children}
    </div>
  );
}

/**
 * The pairing flow: download the agent, paste a one-time code into it.
 *
 * The instance URL comes from the page's own origin, so a self-hosted Saale
 * hands out a command that points back at itself.
 */
export function DesktopPairDialog({
  open,
  onOpenChange,
  downloads,
  pairCode,
  creatingCode,
  onCreateCode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downloads: DesktopDownload[];
  pairCode: { code: string; expiresAt: string } | null;
  creatingCode: boolean;
  onCreateCode: () => void;
  /** Called on close, so a computer that just paired shows up. */
  onDone: () => void;
}) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  // The origin is only known in the browser, and pairing a computer on the same
  // machine is the common case.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const command = pairCode ? `saale-agent pair --url ${origin} --code ${pairCode.code}` : "";

  const copyCommand = () => {
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        toast.success("Pairing command copied");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy the pairing command:", err);
        toast.error("Could not copy the command");
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onDone();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Connect a computer
          </DialogTitle>
          <DialogDescription>
            The agent runs on the computer itself and connects out to this Saale. A chat can use it
            while its newest message came from that computer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <p className="console-label">1 · Install the agent</p>
            {downloads.length === 0 ? (
              <Notice>
                This instance has no agent build to offer. A release ships one; a checkout makes one
                with <code className="font-mono">npm run agent:package</code>.
              </Notice>
            ) : (
              <div className="flex flex-wrap gap-2">
                {downloads.map((download) => (
                  <Button key={download.file} asChild variant="outline" size="sm">
                    <a href={download.url}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      {download.label}
                    </a>
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="console-label">2 · Pair it</p>
            {!pairCode ? (
              <>
                <p className="text-muted-foreground text-sm">
                  Get a code, then paste the command below into a terminal on that computer.
                </p>
                <Button
                  className="h-9 text-xs font-medium"
                  onClick={onCreateCode}
                  disabled={creatingCode}
                >
                  {creatingCode ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <PlugZap className="mr-2 h-3.5 w-3.5" />
                      Get a pairing code
                    </>
                  )}
                </Button>
              </>
            ) : (
              <>
                <div className="bg-muted rounded-2xl border-0 px-4 py-3">
                  <code className="font-mono text-xs break-all">{command}</code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-2"
                    onClick={copyCommand}
                    aria-label="Copy the pairing command"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  The code works once and expires at{" "}
                  {new Date(pairCode.expiresAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  . The computer appears here once it connects.
                </p>
              </>
            )}
          </div>

          <div className="text-muted-foreground flex items-start gap-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The agent decides which tool groups it offers. Turn a group off in its tray menu and
              the model cannot call it at all.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
