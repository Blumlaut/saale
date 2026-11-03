"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronDown, Loader2, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { GlassPanel, GlassPanelHeader } from "@/components/ui/glass-panel";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Page, PageAction, PageActions, PageScroll } from "@/components/layout/page";
import { Hint } from "@/components/shared/hint";
import { Button } from "@/components/ui/button";
import { DailyChart, KindDonut } from "@/components/admin/usage-charts";
import { fetchJson } from "@/lib/http";
import { formatCost, formatCostRounded, formatTokens } from "@/lib/format";
import type { UsageDetail, UsageReport } from "@/lib/admin/usage";
import { USAGE_WINDOWS, type UsageWindow } from "@/lib/admin/usage-windows";
import { cn } from "@/lib/utils";

/** Global takes the accent, local the grey, on every bar in the page. */
const GLOBAL_FILL = "bg-chart-1";
const LOCAL_FILL = "bg-chart-2";

const DEFAULT_WINDOW: UsageWindow = 30;

const WINDOW_OPTIONS = USAGE_WINDOWS.map((days) => ({
  value: String(days),
  label: `${days}d`,
}));

const GLOBAL_HINT = "Usage on the workspace's providers.";
const LOCAL_HINT = "Usage on providers accounts added themselves.";

export function UsageArea() {
  const [days, setDays] = useState<UsageWindow>(DEFAULT_WINDOW);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tallChart, setTallChart] = useState(false);
  // An unfolded account keeps its numbers, so re-opening it does not flicker.
  const [details, setDetails] = useState<Record<string, UsageDetail>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await fetchJson<UsageReport>(`/api/admin/usage?days=${days}`));
      setFailed(false);
    } catch (err) {
      console.error("Failed to load the usage report:", err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page className="gap-4 md:gap-6">
      <GlassPanel className="shrink-0 overflow-hidden">
        <PageActions
          leading={
            <SegmentedControl
              label="Window"
              size="sm"
              value={String(days)}
              options={WINDOW_OPTIONS}
              onChange={(next) => setDays(Number(next) as UsageWindow)}
            />
          }
        >
          <PageAction icon={RefreshCw} label="Refresh" busy={loading} onClick={() => void load()} />
        </PageActions>

        {report ? (
          <StatStrip report={report} />
        ) : (
          <div className="px-4 py-3">
            {failed ? (
              <span className="text-muted-foreground text-sm">Failed to load</span>
            ) : (
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            )}
          </div>
        )}
      </GlassPanel>

      <PageScroll className="space-y-4 md:space-y-6">
        {report ? (
          <>
            <GlassPanel>
              <GlassPanelHeader
                title="Daily"
                action={
                  <div className="flex items-center gap-3">
                    <LegendSwatch fill={GLOBAL_FILL} label="Global" hint={GLOBAL_HINT} />
                    <LegendSwatch fill={LOCAL_FILL} label="Local" hint={LOCAL_HINT} />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tallChart ? "Collapse the chart" : "Expand the chart"}
                      aria-pressed={tallChart}
                      onClick={() => setTallChart((current) => !current)}
                    >
                      {tallChart ? (
                        <Minimize2 className="size-3.5" />
                      ) : (
                        <Maximize2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                }
              />
              <div className="px-4 py-3">
                <DailyChart daily={report.daily} height={tallChart ? "h-80" : "h-48"} />
              </div>
            </GlassPanel>

            <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
              <GlassPanel>
                <GlassPanelHeader title="By type" />
                <div className="px-4 py-3">
                  <KindDonut kinds={report.kinds} total={report.cost} />
                </div>
              </GlassPanel>

              <GlassPanel className="overflow-hidden">
                <GlassPanelHeader title="Top accounts" />
                <div className="px-4 py-3">
                  <TopAccounts rows={report.rows.slice(0, 5)} total={report.cost} />
                </div>
              </GlassPanel>
            </div>

            <GlassPanel className="overflow-hidden">
              <GlassPanelHeader
                title="Accounts"
                action={
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {report.rows.length}
                  </span>
                }
              />
              {report.rows.length === 0 ? (
                <p className="text-muted-foreground px-4 py-6 text-sm">No calls</p>
              ) : (
                <AccountTable
                  rows={report.rows}
                  days={days}
                  open={open}
                  details={details}
                  onLoad={setDetails}
                  onToggle={(userId) => setOpen((current) => (current === userId ? null : userId))}
                />
              )}
            </GlassPanel>
          </>
        ) : null}
      </PageScroll>
    </Page>
  );
}

/** The window's numbers, in one strip under the controls. */
function StatStrip({ report }: { report: UsageReport }) {
  const perCall = report.calls > 0 ? report.cost / report.calls : 0;
  const tokensPerCall =
    report.calls > 0 ? (report.inputTokens + report.outputTokens) / report.calls : 0;

  return (
    <div className="divide-border/50 grid grid-cols-2 divide-y lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.5fr)] lg:divide-x lg:divide-y-0">
      <Stat label="Spend" value={formatCost(report.cost)} note={`${report.calls} calls`} />
      <Stat
        label="Per call"
        value={formatCost(perCall)}
        note={`${formatTokens(tokensPerCall)} tokens`}
      />
      <Stat
        label="Tokens"
        value={formatTokens(report.inputTokens + report.outputTokens)}
        note={`${formatTokens(report.inputTokens)} in · ${formatTokens(report.outputTokens)} out`}
      />
      <div className="px-4 py-3">
        <span className="console-label">Global / Local</span>
        <div className="mt-1.5">
          <SplitBar
            globalCost={report.globalCost}
            ownCost={report.ownCost}
            scale={report.cost}
            legend
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="px-4 py-3">
      <span className="console-label">{label}</span>
      <div className="text-lg tabular-nums">{value}</div>
      {note ? (
        <div className="text-muted-foreground truncate text-[11px] tabular-nums">{note}</div>
      ) : null}
    </div>
  );
}

/** The dearest accounts. Hovering a segment names that half in the line below. */
function TopAccounts({ rows, total }: { rows: UsageReport["rows"]; total: number }) {
  const [hovered, setHovered] = useState<{ userId: string; part: "global" | "local" } | null>(null);
  const largest = rows.reduce((max, row) => Math.max(max, row.cost), 0);
  const active = hovered ? rows.find((row) => row.userId === hovered.userId) : undefined;

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No calls</p>;
  }

  return (
    <div className="space-y-3" onMouseLeave={() => setHovered(null)}>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.userId} className="flex items-center gap-3 py-1">
            <span className="w-24 shrink-0 truncate text-xs md:w-32">{row.name}</span>
            <div className="bg-muted flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  "h-full transition-opacity duration-150",
                  GLOBAL_FILL,
                  hovered !== null && !(hovered.userId === row.userId && hovered.part === "global")
                    ? "opacity-40"
                    : "opacity-100",
                )}
                style={{ width: `${barWidth(row.globalCost, largest)}%` }}
                onMouseEnter={() => setHovered({ userId: row.userId, part: "global" })}
              />
              <div
                className={cn(
                  "h-full transition-opacity duration-150",
                  LOCAL_FILL,
                  hovered !== null && !(hovered.userId === row.userId && hovered.part === "local")
                    ? "opacity-40"
                    : "opacity-100",
                )}
                style={{ width: `${barWidth(row.ownCost, largest)}%` }}
                onMouseEnter={() => setHovered({ userId: row.userId, part: "local" })}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums">
              {formatCostRounded(row.cost)}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground truncate text-[11px] tabular-nums">
        {active && hovered
          ? `${active.name} · ${hovered.part === "global" ? "Global" : "Local"} ${formatCostRounded(
              hovered.part === "global" ? active.globalCost : active.ownCost,
            )} · ${active.calls} calls · ${formatCostRounded(active.cost)}`
          : `${rows.length} accounts · ${formatCostRounded(total)}`}
      </p>
    </div>
  );
}

function AccountTable({
  rows,
  days,
  open,
  details,
  onLoad,
  onToggle,
}: {
  rows: UsageReport["rows"];
  days: UsageWindow;
  open: string | null;
  details: Record<string, UsageDetail>;
  onLoad: Dispatch<SetStateAction<Record<string, UsageDetail>>>;
  onToggle: (userId: string) => void;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-muted-foreground border-border/50 border-b text-[11px]">
          <th className="px-4 py-2 text-left font-medium">Account</th>
          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Calls</th>
          <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">Tokens</th>
          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Global</th>
          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Local</th>
          <th className="px-3 py-2 text-right font-medium">Spend</th>
          <th className="w-10 px-2 py-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expanded = open === row.userId;
          return (
            <Fragment key={row.userId}>
              <tr
                className={cn(
                  "border-border/50 cursor-pointer border-b transition-colors duration-150",
                  expanded ? "bg-accent/40" : "hover:bg-accent/30",
                )}
                onClick={() => onToggle(row.userId)}
              >
                <td className="px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar className="size-7 shrink-0" aria-hidden>
                      {row.image ? <AvatarImage src={row.image} alt="" /> : null}
                      <AvatarFallback>{(row.name[0] ?? "?").toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{row.name}</div>
                      <div className="text-muted-foreground truncate text-xs">{row.email}</div>
                    </div>
                  </div>
                </td>
                <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums md:table-cell">
                  {row.calls}
                </td>
                <td className="text-muted-foreground hidden px-3 py-2.5 text-right text-xs tabular-nums lg:table-cell">
                  {formatTokens(row.inputTokens + row.outputTokens)}
                </td>
                <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums md:table-cell">
                  {formatCostRounded(row.globalCost)}
                </td>
                <td className="text-muted-foreground hidden px-3 py-2.5 text-right text-xs tabular-nums md:table-cell">
                  {formatCostRounded(row.ownCost)}
                </td>
                <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                  {formatCost(row.cost)}
                </td>
                <td className="px-2 py-2.5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} ${row.name}`}
                    className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md transition-colors duration-150"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggle(row.userId);
                    }}
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform duration-150",
                        expanded && "rotate-180",
                      )}
                    />
                  </button>
                </td>
              </tr>
              {expanded ? (
                <tr className="border-border/50 border-b">
                  <td colSpan={7} className="bg-muted/20 px-4 py-3">
                    <AccountDetail
                      userId={row.userId}
                      days={days}
                      initial={details[`${row.userId}:${days}`]}
                      onLoad={onLoad}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** One account's own numbers, read the first time its row is unfolded. */
function AccountDetail({
  userId,
  days,
  initial,
  onLoad,
}: {
  userId: string;
  days: UsageWindow;
  initial: UsageDetail | undefined;
  onLoad: Dispatch<SetStateAction<Record<string, UsageDetail>>>;
}) {
  const key = `${userId}:${days}`;
  const [detail, setDetail] = useState<UsageDetail | null>(initial ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (detail) return;
    let live = true;
    fetchJson<UsageDetail>(`/api/admin/usage/${encodeURIComponent(userId)}?days=${days}`)
      .then((next) => {
        onLoad((previous) => ({ ...previous, [key]: next }));
        if (live) setDetail(next);
      })
      .catch((err) => {
        console.error("Failed to load an account's usage:", err);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [detail, key, onLoad, userId, days]);

  if (!detail) {
    return failed ? (
      <span className="text-muted-foreground text-sm">Failed to load</span>
    ) : (
      <Loader2 className="text-muted-foreground size-4 animate-spin" />
    );
  }

  return (
    <div className="space-y-3">
      <div className="max-w-2xl space-y-1.5">
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {detail.calls} calls · {formatTokens(detail.inputTokens)} in ·{" "}
          {formatTokens(detail.outputTokens)} out
        </span>
        <SplitBar
          globalCost={detail.globalCost}
          ownCost={detail.ownCost}
          scale={detail.cost}
          legend
          paidBy="user"
        />
      </div>

      <div className="space-y-1.5">
        <span className="console-label">Daily</span>
        <DailyChart daily={detail.daily} height="h-28" axis={false} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <span className="console-label">By type</span>
          <KindDonut kinds={detail.kinds} total={detail.cost} size="size-28" tokens />
        </div>

        <div className="space-y-1.5">
          <span className="console-label">Providers</span>
          {detail.providers.map((provider) => (
            <div key={provider.provider} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{provider.provider}</span>
              <span className="text-muted-foreground w-12 shrink-0 text-right text-[11px] tabular-nums">
                {provider.calls}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">
                {formatCostRounded(provider.cost)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Global against local, on one bar. `scale` is the total it is measured against. */
function SplitBar({
  globalCost,
  ownCost,
  scale,
  legend,
  paidBy,
}: {
  globalCost: number;
  ownCost: number;
  scale: number;
  legend?: boolean;
  /** Whose providers the local half came from: every account, or the one on screen. */
  paidBy?: "users" | "user";
}) {
  return (
    <div className="space-y-1.5">
      <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full", GLOBAL_FILL)}
          style={{ width: `${share(globalCost, scale)}%` }}
        />
        <div className={cn("h-full", LOCAL_FILL)} style={{ width: `${share(ownCost, scale)}%` }} />
      </div>
      {legend ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <LegendSwatch
            fill={GLOBAL_FILL}
            label="Global"
            value={formatCost(globalCost)}
            hint={GLOBAL_HINT}
          />
          <LegendSwatch
            fill={LOCAL_FILL}
            label="Local"
            value={formatCost(ownCost)}
            hint={paidBy === "user" ? "Usage on providers this account added itself." : LOCAL_HINT}
          />
        </div>
      ) : null}
    </div>
  );
}

function LegendSwatch({
  fill,
  label,
  value,
  hint,
}: {
  fill: string;
  label: string;
  value?: string;
  hint: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-sm", fill)} aria-hidden />
      <span className="text-muted-foreground max-w-40 truncate text-[11px]">{label}</span>
      {value ? <span className="text-[11px] tabular-nums">{value}</span> : null}
      <Hint text={hint} className="text-muted-foreground/70 hover:text-foreground inline-flex" />
    </span>
  );
}

/** A slice's share of the whole, as a percentage of the bar. */
function share(value: number, total: number): number {
  if (total <= 0 || value <= 0) return 0;
  return Math.min((value / total) * 100, 100);
}

/** A bar width that keeps a small amount visible. */
function barWidth(value: number, total: number): number {
  if (total <= 0 || value <= 0) return 0;
  return Math.max(share(value, total), 0.8);
}
