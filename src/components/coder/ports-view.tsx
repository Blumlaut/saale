"use client";

import { useMemo, useState } from "react";
import { Copy, ExternalLink, MoreVertical, Square, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { usePorts } from "./use-ports";

/** A row's port and the process behind it. */
function commandLabel(command: string | null): string {
  if (!command) return "unknown process";
  return command;
}

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
    <div className="flex shrink-0 flex-col gap-1 border-t px-3 py-3">
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
 * The Ports tab: what the worktree is listening on.
 *
 * The agent starts servers with its own tools, so this list is the interface:
 * every process that listens inside the worktree shows up here with a link that
 * opens it, without anyone registering it.
 */
export function PortsView({ view }: { view: ReturnType<typeof usePorts> }) {
  const { data, error, stop } = view;
  const [stopping, setStopping] = useState<number | null>(null);

  const ports = useMemo(() => data?.ports ?? [], [data]);
  // A loopback bind is the one case a row cannot open, so it gets the reason.
  const loopback = ports.find((entry) => entry.loopback && !entry.url) ?? null;

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

  if (error && !data) {
    return <p className="text-destructive px-3 py-3 text-xs break-words">{error}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ports.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {ports.map((entry) => (
            <div key={entry.port} className="flex items-center gap-1 px-2 py-1.5">
              <span className="text-muted-foreground text-[11px] tabular-nums">{entry.port}</span>
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
                title={commandLabel(entry.command)}
              >
                {commandLabel(entry.command)}
              </span>
              {entry.loopback ? (
                <span className="text-muted-foreground shrink-0 text-[10px]">loopback</span>
              ) : null}
              {entry.url ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Open port ${entry.port} in a new tab`}
                  title={entry.url}
                  className="h-6 w-6 shrink-0"
                  render={<a href={entry.url} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              ) : null}
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
                    <DropdownMenuItem
                      onClick={() => void copyText(entry.url as string, "Preview link copied")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy link
                    </DropdownMenuItem>
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
      ) : (
        <EmptyState enabled={data?.enabled === true} />
      )}

      {loopback ? <LoopbackHint port={loopback.port} /> : null}
    </div>
  );
}
