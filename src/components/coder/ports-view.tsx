"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  ExternalLink,
  Loader2,
  MoreVertical,
  Play,
  Radio,
  RotateCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePorts, type PreviewSetupInfo } from "./use-ports";

/** A row's port and the process behind it. */
function commandLabel(command: string | null): string {
  if (!command) return "unknown process";
  return command;
}

/**
 * The setup an operator has to do once, shown where the missing preview would be.
 *
 * The block is printed with this deployment's own domain filled in, and the
 * check button goes through the public hostname, so a green answer means DNS,
 * the certificate, nginx and this service all line up.
 */
/** Write to the clipboard, and say so either way. */
async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch (err) {
    console.error("Failed to copy:", err);
    toast.error("Could not copy");
  }
}

function SetupCard({ setup }: { setup: PreviewSetupInfo }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"ok" | "failed" | null>(null);

  const check = async () => {
    if (!setup.probeUrl) return;
    setChecking(true);
    setResult(null);
    try {
      // no-cors: the answer is opaque, so reaching the proxy at all is the test.
      await fetch(setup.probeUrl, { mode: "no-cors", cache: "no-store" });
      setResult("ok");
    } catch (err) {
      console.error("Preview health check failed:", err);
      setResult("failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center gap-1.5">
        <Radio className="text-muted-foreground h-3.5 w-3.5" />
        <p className="text-xs font-medium">
          {setup.probeUrl ? "Preview setup" : "Previews are off"}
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        {setup.probeUrl
          ? `Every port is served on a hostname under ${setup.domain}. If a preview does not load, this vhost is what to check.`
          : "Previews need a wildcard domain. Point *.preview.example.com at this server, get a certificate for it, and add this vhost."}
      </p>
      <div className="relative">
        <pre className="bg-muted/40 overflow-x-auto rounded-lg p-2 font-mono text-[10px] leading-relaxed whitespace-pre">
          {setup.nginx}
        </pre>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy the nginx block"
          className="bg-background/80 absolute top-1 right-1 h-6 w-6"
          onClick={() => void copyText(setup.nginx, "nginx block copied")}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {setup.probeUrl ? (
          <Button variant="secondary" size="sm" className="h-7 gap-1.5 text-xs" onClick={check}>
            {checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Check
          </Button>
        ) : null}
        {result === "ok" ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">Reachable</span>
        ) : result === "failed" ? (
          <span className="text-destructive text-xs">
            No answer from {setup.domain}. DNS, certificate or nginx is missing.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({ enabled }: { enabled: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <TerminalSquare className="text-muted-foreground/50 h-5 w-5" />
      <p className="text-xs font-medium">Nothing is running</p>
      <p className="text-muted-foreground text-xs">
        {enabled
          ? "Start the project in the Terminal tab, or ask the agent to. A port appears here as soon as it listens."
          : "Start the project in the Terminal tab and its port appears here."}
      </p>
    </div>
  );
}

function LoopbackHint({ port }: { port: number }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-4">
      <p className="text-xs font-medium">Port {port} only listens on 127.0.0.1</p>
      <p className="text-muted-foreground text-xs">
        Nothing outside the container can reach that address. Start the server on{" "}
        <code className="font-mono text-[11px]">0.0.0.0</code> instead, for example{" "}
        <code className="font-mono text-[11px]">npm run dev -- --host 0.0.0.0</code>.
      </p>
    </div>
  );
}

/**
 * The Ports tab: what the worktree is listening on, and the running app itself.
 *
 * The agent starts servers with its own tools, so this list is the interface:
 * every process that listens inside the worktree shows up here with a preview
 * link, without anyone registering it.
 */
export function PortsView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { data, error, stop } = usePorts(sessionId, active);
  const [selected, setSelected] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [stopping, setStopping] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  const ports = useMemo(() => data?.ports ?? [], [data]);
  const current = ports.find((entry) => entry.port === selected) ?? ports[0] ?? null;

  // A server that stops takes its preview with it.
  useEffect(() => {
    if (selected === null) return;
    if (ports.some((entry) => entry.port === selected)) return;
    setSelected(null);
  }, [ports, selected]);

  const kill = async (port: number) => {
    setStopping(port);
    try {
      await stop(port);
      toast.success(`Stopped port ${port}`);
    } catch (err) {
      console.error(`Failed to stop port ${port}:`, err);
      toast.error(err instanceof Error ? err.message : "Could not stop that server");
    } finally {
      setStopping(null);
    }
  };

  // The block is what the operator pastes, so it is on screen by default while
  // previews are off, and behind a button once they work.
  const showSetup = data ? !data.enabled || setupOpen : false;
  const setupCard = data?.setup ? <SetupCard setup={data.setup} /> : null;

  if (error && !data) {
    return <p className="text-destructive px-3 py-3 text-xs break-words">{error}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSetup ? setupCard : null}

      {ports.length > 0 ? (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b">
          {ports.map((entry) => (
            <div
              key={entry.port}
              className={cn(
                "group flex items-center gap-2 px-2 py-1.5",
                current?.port === entry.port && "bg-accent",
              )}
            >
              <button
                type="button"
                onClick={() => setSelected(entry.port)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-label={`Show port ${entry.port}`}
              >
                <span className="font-mono text-xs">{entry.port}</span>
                <span
                  className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
                  title={commandLabel(entry.command)}
                >
                  {commandLabel(entry.command)}
                </span>
                {entry.loopback ? (
                  <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                    loopback
                  </span>
                ) : null}
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Port ${entry.port} actions`}
                      className="h-6 w-6 shrink-0"
                    />
                  }
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  {entry.url ? (
                    <>
                      <DropdownMenuItem
                        render={<a href={entry.url} target="_blank" rel="noreferrer" />}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open in a new tab
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void copyText(entry.url as string, "Preview link copied")}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy link
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  <DropdownMenuItem
                    onClick={() => void kill(entry.port)}
                    disabled={stopping === entry.port}
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop server
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      ) : data && !data.enabled ? null : (
        <div className="flex flex-col">
          <EmptyState enabled={data?.enabled === true} />
          {data?.enabled ? (
            <div className="px-3 pb-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setSetupOpen((value) => !value)}
              >
                {setupOpen ? "Hide preview setup" : "Check preview setup"}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {current ? (
        current.url ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]"
                title={current.url}
              >
                {current.url.replace(/^https?:\/\//, "")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Reload the preview"
                className="h-6 w-6"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open the preview in a new tab"
                className="h-6 w-6"
                onClick={() => window.open(current.url as string, "_blank", "noreferrer")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
            <iframe
              key={`${current.url}-${reloadKey}`}
              src={current.url}
              title={`Preview of port ${current.port}`}
              className="min-h-0 w-full flex-1 border-0 bg-white"
            />
          </div>
        ) : current.loopback ? (
          <LoopbackHint port={current.port} />
        ) : null
      ) : null}
    </div>
  );
}
