"use client";

import { useRouter } from "next/navigation";
import { Loader2, Plug, Plus, Server, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMachines } from "@/hooks/use-machines";

/** The machine the browser is pointed at, as the page remembers it. */
export interface ConnectedMachine {
  id: string;
  name: string;
}

/**
 * The browser's way onto a server.
 *
 * Connecting points the browser at the machine's home directory over SFTP,
 * which is the same target token the user's own files use, so everything the
 * page does works there too.
 */
export function ConnectMenu({
  machine,
  onConnect,
  onDisconnect,
}: {
  /** The machine the browser is on, or null for the user's own files. */
  machine: ConnectedMachine | null;
  onConnect: (machine: ConnectedMachine) => void;
  onDisconnect: () => void;
}) {
  const router = useRouter();
  const { machines, loading, error } = useMachines();

  if (machine) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-xs"
        aria-label={`Disconnect from ${machine.name}`}
        onClick={onDisconnect}
      >
        <Unplug className="h-4 w-4" />
        <span className="hidden @min-[520px]:inline">Disconnect</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(triggerProps) => (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            aria-label="Connect to a server"
            {...triggerProps}
          >
            <Plug className="h-4 w-4" />
            <span className="hidden @min-[520px]:inline">Connect…</span>
          </Button>
        )}
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Connect to</DropdownMenuLabel>

          {loading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
              <span className="text-muted-foreground">Loading your servers…</span>
            </div>
          ) : error ? (
            <p className="text-destructive px-2 py-1.5 text-xs break-words">{error}</p>
          ) : machines.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              No servers yet. Add one with its address and a way to sign in.
            </p>
          ) : (
            machines.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => onConnect({ id: entry.id, name: entry.name })}
              >
                <Server className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.name}</span>
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {entry.username}@{entry.host}
                  </span>
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/dashboard/infra")}>
          <Plus className="h-3.5 w-3.5" />
          Add a server
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
