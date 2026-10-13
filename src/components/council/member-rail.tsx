"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CouncilMemberView } from "@/types/council";
import type { CouncilMemberLive } from "./use-council-stream";
import { Loader2, Wrench } from "lucide-react";

export interface MemberRailProps {
  councilId: string;
  members: CouncilMemberView[];
  /** Live per-member state, keyed by member id. Absent while the room is quiet. */
  live: Record<string, CouncilMemberLive>;
  /** `list` is the desktop right rail; `strip` is the mobile horizontal strip. */
  variant: "list" | "strip";
}

function modelLabel(member: CouncilMemberView): string {
  if (member.modelProvider && member.modelName) {
    return `${member.modelName} · ${member.modelProvider}`;
  }
  return "Default model";
}

function LiveHint({ state }: { state: CouncilMemberLive | undefined }) {
  if (!state) return null;
  if (state.busy) {
    const calls = state.toolCalls.length;
    return (
      <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-[11px]">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="truncate">
          {calls > 0 ? `running ${calls} tool${calls === 1 ? "" : "s"}…` : "thinking…"}
        </span>
      </span>
    );
  }
  if (state.toolCalls.length > 0) {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
        <Wrench className="h-3 w-3 shrink-0" />
        {state.toolCalls.length} tool{state.toolCalls.length === 1 ? "" : "s"}
      </span>
    );
  }
  return null;
}

function MemberRow({
  councilId,
  member,
  state,
  compact,
}: {
  councilId: string;
  member: CouncilMemberView;
  state: CouncilMemberLive | undefined;
  compact: boolean;
}) {
  return (
    <Link
      href={`/dashboard/council/${councilId}/member/${member.id}`}
      className={cn(
        "hover:bg-accent/60 flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors",
        compact && "w-44 shrink-0",
        !member.enabled && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {state?.busy && <Loader2 className="text-primary h-3 w-3 shrink-0 animate-spin" />}
        <span className="truncate text-sm font-medium">{member.name}</span>
        {!member.enabled && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            off
          </Badge>
        )}
      </span>
      {!compact && (
        <span className="text-muted-foreground truncate text-[11px]">{modelLabel(member)}</span>
      )}
      {!compact && <LiveHint state={state} />}
      {compact && <LiveHint state={state} />}
    </Link>
  );
}

/**
 * The members of the room.
 *
 * Desktop gets the vertical right rail; phones get a horizontally scrollable
 * strip instead, so a member stays reachable without hovering (there is no
 * hover on a touch device).
 */
export function MemberRail({ councilId, members, live, variant }: MemberRailProps) {
  const empty = <p className="text-muted-foreground px-3 py-2 text-xs">No members yet.</p>;

  if (variant === "strip") {
    return (
      <div
        className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto border-b px-4 py-2"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {members.length === 0
          ? empty
          : members.map((member) => (
              <MemberRow
                key={member.id}
                councilId={councilId}
                member={member}
                state={live[member.id]}
                compact
              />
            ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="console-label shrink-0 px-3 pt-3 pb-1">Members · {members.length}</div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {members.length === 0
          ? empty
          : members.map((member) => (
              <MemberRow
                key={member.id}
                councilId={councilId}
                member={member}
                state={live[member.id]}
                compact={false}
              />
            ))}
      </div>
      <div className="border-t px-3 py-2">
        <p className="text-muted-foreground text-[11px]">
          Members post only through the council_post tool. Open a member to read its private
          reasoning and tool calls.
        </p>
      </div>
    </div>
  );
}
