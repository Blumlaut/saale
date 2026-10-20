"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Page, PageScroll } from "@/components/layout/page";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentTranscript } from "@/components/council/agent-transcript";
import { fetchJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { MAX_ROOM_PAGE } from "@/lib/council/config";
import type { CouncilDetail, CouncilMessageView, CouncilTurnView } from "@/types/council";
import { ChevronLeft, Loader2 } from "lucide-react";

/** The value of the run selector that means "show every run". */
const ALL_RUNS = "all";

/**
 * One member's private transcript.
 *
 * A member's reasoning and tool calls happen outside the room; this is the only
 * place they are readable. Turns are newest first, filtered by run.
 */
export default function CouncilMemberPage() {
  const params = useParams<{ councilId: string; memberId: string }>();
  const councilId = params?.councilId ?? "";
  const memberId = params?.memberId ?? "";

  const [council, setCouncil] = useState<CouncilDetail | null>(null);
  const [turns, setTurns] = useState<CouncilTurnView[]>([]);
  const [messages, setMessages] = useState<CouncilMessageView[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>(ALL_RUNS);
  const [loading, setLoading] = useState(true);

  const member = council?.members.find((m) => m.id === memberId) ?? null;

  const loadCouncil = useCallback(async () => {
    if (!councilId) return;
    try {
      const data = await fetchJson<{ council: CouncilDetail }>(`/api/council/${councilId}`);
      setCouncil(data.council);
    } catch (err) {
      console.error("Failed to load the council for a member transcript:", err);
    }
  }, [councilId]);

  const loadMessages = useCallback(async () => {
    if (!councilId) return;
    try {
      const data = await fetchJson<{ messages: CouncilMessageView[] }>(
        `/api/council/${councilId}/messages?limit=${MAX_ROOM_PAGE}`,
      );
      setMessages(data.messages);
    } catch (err) {
      console.error("Failed to load the room for seq labels:", err);
    }
  }, [councilId]);

  const loadTurns = useCallback(async () => {
    if (!councilId || !memberId) return;
    const query = new URLSearchParams({ memberId, limit: "100" });
    if (selectedRun !== ALL_RUNS) query.set("runId", selectedRun);
    try {
      const data = await fetchJson<{ turns: CouncilTurnView[] }>(
        `/api/council/${councilId}/turns?${query.toString()}`,
      );
      setTurns(data.turns);
    } catch (err) {
      console.error("Failed to load a member's turns:", err);
    }
  }, [councilId, memberId, selectedRun]);

  useEffect(() => {
    if (!councilId || !memberId) return;
    setLoading(true);
    Promise.all([loadCouncil(), loadMessages()]).finally(() => setLoading(false));
  }, [councilId, memberId, loadCouncil, loadMessages]);

  useEffect(() => {
    void loadTurns();
  }, [loadTurns]);

  if (!councilId || !memberId) return null;

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 md:px-6">
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <Link href={`/dashboard/council/${councilId}`} aria-label="Back to the room">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{member?.name ?? "Member"}</span>
              {member && !member.enabled && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  off
                </Badge>
              )}
              <span className="text-muted-foreground hidden truncate text-[11px] sm:inline">
                private transcript. not visible to the room
              </span>
            </div>

            <div className="ml-auto w-full sm:w-60">
              <Select
                value={selectedRun}
                onValueChange={(value) => setSelectedRun(value ?? ALL_RUNS)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All runs" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_RUNS}>All runs</SelectItem>
                  {(council?.runs ?? []).map((run) => (
                    <SelectItem key={run.id} value={run.id}>
                      {formatRelativeDate(run.createdAt)} · {run.status}
                      {run.stopReason ? ` · ${run.stopReason}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <PageScroll className="px-4 py-4 md:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {loading && turns.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                </div>
              ) : (
                <AgentTranscript turns={turns} messages={messages} loading={loading} />
              )}
            </div>
          </PageScroll>
        </GlassPanel>
      </div>
    </Page>
  );
}
