"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Page } from "@/components/layout/page";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { MessageTimeline } from "@/components/council/message-timeline";
import { MemberRail } from "@/components/council/member-rail";
import { Composer } from "@/components/council/composer";
import { ConveneButton, RunStatus, type RunBudgetInput } from "@/components/council/run-status";
import { useCouncilStream } from "@/components/council/use-council-stream";
import { fetchJson, postJson } from "@/lib/http";
import { COUNCIL_ORCHESTRATIONS, MAX_ROOM_PAGE } from "@/lib/council/config";
import type { CouncilDetail, CouncilMessageView } from "@/types/council";
import { ChevronLeft, FolderOpen, Loader2, Square } from "lucide-react";

/**
 * The council room.
 *
 * Desktop is a main column (timeline + composer) with a members rail on the
 * right; on phones the rail becomes a horizontally scrollable strip so it stays
 * reachable without hover. The room's messages always come from the REST route
 *. the SSE stream is only a signal to refetch plus the members' live state.
 */
export default function CouncilRoomPage() {
  const params = useParams<{ councilId: string }>();
  const councilId = params?.councilId ?? "";

  const [council, setCouncil] = useState<CouncilDetail | null>(null);
  const [messages, setMessages] = useState<CouncilMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [convening, setConvening] = useState(false);
  const [stopping, setStopping] = useState(false);

  const loadMessages = useCallback(async () => {
    if (!councilId) return;
    try {
      const data = await fetchJson<{ messages: CouncilMessageView[]; lastSeq: number }>(
        `/api/council/${councilId}/messages?limit=${MAX_ROOM_PAGE}`,
      );
      setMessages(data.messages);
    } catch (err) {
      console.error("Failed to load the council room:", err);
    }
  }, [councilId]);

  // The stream's run callbacks need the latest loader without rebuilding the
  // stream connection. The ref is declared before the hook so its callbacks can
  // read it; the loader itself is defined below and kept current by an effect.
  const loadCouncilRef = useRef<() => Promise<void>>(async () => {});

  const stream = useCouncilStream({
    councilId,
    onRoomChanged: () => void loadMessages(),
    onRunStarted: () => void loadCouncilRef.current(),
    onRunEnded: () => void loadCouncilRef.current(),
  });
  const { seedRun } = stream;

  const loadCouncil = useCallback(async () => {
    if (!councilId) return;
    try {
      const data = await fetchJson<{ council: CouncilDetail }>(`/api/council/${councilId}`);
      setCouncil(data.council);
      setError("");
      if (data.council.activeRun) {
        seedRun(data.council.activeRun.id, {
          inputTokens: data.council.activeRun.inputTokens,
          outputTokens: data.council.activeRun.outputTokens,
          cost: data.council.activeRun.cost,
          turnCount: data.council.activeRun.turnCount,
        });
      }
    } catch (err) {
      console.error("Failed to load the council:", err);
      setError(err instanceof Error ? err.message : "Could not load this council.");
    }
  }, [councilId, seedRun]);

  useEffect(() => {
    loadCouncilRef.current = loadCouncil;
  }, [loadCouncil]);

  useEffect(() => {
    if (!councilId) return;
    setLoading(true);
    Promise.all([loadCouncil(), loadMessages()]).finally(() => setLoading(false));
  }, [councilId, loadCouncil, loadMessages]);

  const convene = useCallback(
    async (budget: RunBudgetInput) => {
      if (!councilId) return;
      setConvening(true);
      setActionError("");
      try {
        await postJson(`/api/council/${councilId}/run`, budget);
        await loadCouncil();
      } catch (err) {
        console.error("Failed to convene the council:", err);
        setActionError(err instanceof Error ? err.message : "Could not start a run.");
      } finally {
        setConvening(false);
      }
    },
    [councilId, loadCouncil],
  );

  const stop = useCallback(async () => {
    if (!councilId) return;
    setStopping(true);
    setActionError("");
    try {
      await postJson(`/api/council/${councilId}/abort`, {});
      await loadCouncil();
    } catch (err) {
      console.error("Failed to stop the council run:", err);
      setActionError(err instanceof Error ? err.message : "Could not stop the run.");
    } finally {
      setStopping(false);
    }
  }, [councilId, loadCouncil]);

  if (!councilId) return null;

  const running = council?.status === "running" || Boolean(council?.activeRun);
  const waiting = council?.status === "waiting";
  const run = council?.activeRun ?? council?.runs[0] ?? null;
  const orchestrationLabel =
    COUNCIL_ORCHESTRATIONS.find((option) => option.value === council?.orchestration)?.label ?? "";

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          {/* Toolbar. back, room identity, then the run actions */}
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 md:px-6">
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <Link href="/dashboard/council" aria-label="Back to councils">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{council?.name ?? "Council"}</span>
              {orchestrationLabel && (
                <span className="text-muted-foreground text-[11px]">{orchestrationLabel}</span>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
                <Link
                  href={`/dashboard/council/${councilId}/files`}
                  aria-label="Council workspace files"
                >
                  <FolderOpen className="h-4 w-4" />
                </Link>
              </Button>
              {running && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-8 gap-1.5 md:h-9"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  {stopping ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  <span className="hidden md:inline">Stop</span>
                </Button>
              )}
              <ConveneButton
                disabled={!council || running}
                pending={convening}
                onConvene={(budget) => void convene(budget)}
                defaults={{
                  maxDurationSeconds: council?.maxDurationSeconds ?? null,
                  maxTokens: council?.maxTokens ?? null,
                  maxCostUsd: council?.maxCostUsd ?? null,
                }}
              />
            </div>
          </div>

          {council && (
            <RunStatus
              councilStatus={council.status}
              run={run}
              running={running}
              totals={stream.totals}
              connected={stream.connected}
              enabledMemberCount={council.enabledMemberCount}
            />
          )}

          {actionError && (
            <p className="text-destructive border-b px-4 py-1.5 text-xs md:px-6">{actionError}</p>
          )}

          {error && !council ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-10 text-center">
              <p className="text-destructive text-sm">{error}</p>
              <p className="text-muted-foreground text-xs">
                The council module is available only to admins, and only when it is enabled.
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {council && (
                  <div className="md:hidden">
                    <MemberRail
                      councilId={councilId}
                      members={council.members}
                      live={stream.members}
                      variant="strip"
                    />
                  </div>
                )}
                <MessageTimeline
                  councilId={councilId}
                  messages={messages}
                  members={council?.members ?? []}
                  live={stream.members}
                  loading={loading}
                />
                <Composer
                  councilId={councilId}
                  members={council?.members ?? []}
                  running={running}
                  waiting={waiting}
                  onPosted={() => {
                    void loadMessages();
                    void loadCouncil();
                  }}
                />
              </div>

              {council && (
                <aside className="hidden min-h-0 w-64 shrink-0 flex-col border-l md:flex">
                  <MemberRail
                    councilId={councilId}
                    members={council.members}
                    live={stream.members}
                    variant="list"
                  />
                </aside>
              )}
            </div>
          )}
        </GlassPanel>
      </div>
    </Page>
  );
}
