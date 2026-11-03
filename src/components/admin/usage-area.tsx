"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Hint } from "@/components/shared/hint";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageAction, PageActions, PageScroll, PageTabStrip } from "@/components/layout/page";
import { fetchJson } from "@/lib/http";
import { formatCost, formatCostRounded, formatTokens } from "@/lib/format";
import type { UsageDay, UsageDetail, UsageKindTotals, UsageReport } from "@/lib/admin/usage";
import { USAGE_WINDOWS, type UsageWindow } from "@/lib/admin/usage-windows";
import type { UsageKind } from "@/lib/usage/record";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<UsageKind, string> = {
  chat: "chat",
  coder: "coder",
  council: "council",
  job: "jobs",
  automation: "automations",
  email_draft: "drafts",
};

/** Ours takes the accent; theirs is the grey, on every bar in the page. */
const OURS_FILL = "bg-chart-1";
const THEIRS_FILL = "bg-chart-2";

const DEFAULT_WINDOW: UsageWindow = 30;

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function UsageArea() {
  const [days, setDays] = useState<UsageWindow>(DEFAULT_WINDOW);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
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

  const rows = report?.rows ?? [];
  const largest = rows.reduce((max, row) => Math.max(max, row.cost), 0);

  return (
    <Page className="gap-0">
      <Tabs
        value={String(days)}
        onValueChange={(next) => setDays(Number(next) as UsageWindow)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <PageActions
            leading={
              report ? (
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className="truncate font-mono text-sm tabular-nums">
                    {formatCost(report.cost)}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-xs tabular-nums">
                    {report.calls} calls
                  </span>
                </div>
              ) : null
            }
          >
            <PageAction
              icon={RefreshCw}
              label="Refresh"
              busy={loading}
              onClick={() => void load()}
            />
          </PageActions>

          <PageTabStrip className="border-border/50 border-b px-2 py-1.5">
            <TabsList>
              {USAGE_WINDOWS.map((window) => (
                <TabsTrigger key={window} value={String(window)} className="px-3 text-xs">
                  {window}d
                </TabsTrigger>
              ))}
            </TabsList>
          </PageTabStrip>

          <PageScroll>
            {report ? <GlobalStats report={report} /> : null}
            {!report && failed ? (
              <p className="text-muted-foreground px-4 py-6 text-sm">Failed to load</p>
            ) : null}
            {!report && !failed ? <LoadingLine /> : null}

            {report ? (
              <>
                <div className="border-border/50 flex items-center justify-between gap-2 border-b px-4 py-2">
                  <span className="console-label">Accounts</span>
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {rows.length}
                  </span>
                </div>
                {rows.length === 0 ? (
                  <p className="text-muted-foreground px-4 py-6 text-sm">No calls</p>
                ) : null}
                {rows.map((row, index) => (
                  <Fragment key={row.userId}>
                    <AccountRow
                      row={row}
                      largest={largest}
                      days={days}
                      open={open === row.userId}
                      detail={details[`${row.userId}:${days}`]}
                      onLoad={setDetails}
                      onOpenChange={(next) => setOpen(next ? row.userId : null)}
                    />
                    {index < rows.length - 1 && <Separator className="px-4" />}
                  </Fragment>
                ))}
              </>
            ) : null}
          </PageScroll>
        </GlassPanel>
      </Tabs>
    </Page>
  );
}

/** The window as a whole: the headline numbers, then spend by day and by type. */
function GlobalStats({ report }: { report: UsageReport }) {
  return (
    <div className="border-border/50 grid gap-4 border-b px-4 py-3 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] md:gap-6 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_minmax(0,24rem)]">
      <div className="space-y-3">
        <FigureRow
          items={[
            { label: "Spend", value: formatCost(report.cost) },
            { label: "Calls", value: String(report.calls) },
            { label: "In", value: formatTokens(report.inputTokens) },
            { label: "Out", value: formatTokens(report.outputTokens) },
          ]}
        />

        <SplitBar
          globalCost={report.globalCost}
          ownCost={report.ownCost}
          scale={report.cost}
          legend
        />
      </div>

      <DailyBars daily={report.daily} />

      <KindPie kinds={report.kinds} total={report.cost} />
    </div>
  );
}

/** One account, folded to its totals and unfolded to its own breakdown. */
function AccountRow({
  row,
  largest,
  days,
  open,
  detail,
  onLoad,
  onOpenChange,
}: {
  row: UsageReport["rows"][number];
  largest: number;
  days: UsageWindow;
  open: boolean;
  detail: UsageDetail | undefined;
  onLoad: Dispatch<SetStateAction<Record<string, UsageDetail>>>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150">
        <Avatar className="size-8" aria-hidden>
          {row.image ? <AvatarImage src={row.image} alt="" /> : null}
          <AvatarFallback>{(row.name[0] ?? "?").toUpperCase()}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{row.name}</span>
          <span className="text-muted-foreground block truncate text-xs">{row.email}</span>
          <div className="mt-2 max-w-56 md:max-w-sm">
            <SplitBar globalCost={row.globalCost} ownCost={row.ownCost} scale={largest} />
          </div>
        </div>

        <div className="w-20 shrink-0 text-right md:w-24">
          <div className="truncate font-mono text-xs tabular-nums md:text-sm">
            {formatCost(row.cost)}
          </div>
          <div className="text-muted-foreground truncate text-[11px] tabular-nums">
            {formatTokens(row.inputTokens + row.outputTokens)}
          </div>
        </div>

        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <AccountDetail userId={row.userId} days={days} initial={detail} onLoad={onLoad} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** An account's own numbers, read the first time its row is unfolded. */
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
    return (
      <div className="border-border/50 bg-muted/20 border-t px-4 py-4">
        {failed ? (
          <span className="text-muted-foreground text-sm">Failed to load</span>
        ) : (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        )}
      </div>
    );
  }

  return (
    <div className="px-3 pb-3">
      <div className="border-border/50 bg-muted/20 space-y-3 rounded-lg border p-3">
        <SplitBar
          globalCost={detail.globalCost}
          ownCost={detail.ownCost}
          scale={detail.cost}
          legend
          paidBy="user"
        />

        <p className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {detail.calls} calls · {formatTokens(detail.inputTokens)} in ·{" "}
          {formatTokens(detail.outputTokens)} out
        </p>

        <DailyBars daily={detail.daily} height="h-10" />

        <Breakdown
          total={detail.cost}
          items={detail.kinds.map((kind) => ({
            label: KIND_LABELS[kind.kind],
            cost: kind.cost,
            calls: kind.calls,
            globalCost: kind.globalCost,
            ownCost: kind.ownCost,
            tokens: { input: kind.inputTokens, output: kind.outputTokens },
          }))}
        />

        <div className="space-y-1">
          <span className="console-label">Providers</span>
          {detail.providers.map((provider) => (
            <div key={provider.provider} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{provider.provider}</span>
              <span className="shrink-0 font-mono tabular-nums">
                {formatCostRounded(provider.cost)}
              </span>
              <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-[11px] tabular-nums">
                {provider.calls}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Label and number, the unit every block in the page is built from. */
function FigureRow({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="flex items-baseline gap-1.5">
          <span className="console-label">{item.label}</span>
          <span className="font-mono text-sm tabular-nums">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Ours against theirs. `scale` is the total the bar is measured against: the
 * block's own total for a share, the largest account for comparing rows.
 */
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
        {globalCost > 0 ? (
          <div
            className={cn("h-full", OURS_FILL)}
            style={{ width: `${percent(globalCost, scale)}%` }}
          />
        ) : null}
        {ownCost > 0 ? (
          <div
            className={cn("h-full", THEIRS_FILL)}
            style={{ width: `${percent(ownCost, scale)}%` }}
          />
        ) : null}
      </div>
      {legend ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <LegendItem
            fill={OURS_FILL}
            label="Global"
            value={formatCost(globalCost)}
            hint="Usage on the workspace's providers."
          />
          <LegendItem
            fill={THEIRS_FILL}
            label="Local"
            value={formatCost(ownCost)}
            hint={
              paidBy === "user"
                ? "Usage on providers this account added itself."
                : "Usage on providers accounts added themselves."
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function LegendItem({
  fill,
  label,
  value,
  hint,
}: {
  fill: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-sm", fill)} aria-hidden />
      <span className="text-muted-foreground max-w-40 truncate text-[11px]">{label}</span>
      <span className="font-mono text-[11px] tabular-nums">{value}</span>
      <Hint text={hint} className="text-muted-foreground/70 hover:text-foreground inline-flex" />
    </span>
  );
}

/** One hue, stepped down the list: the biggest kind is the solid slice. */
const PIE_STEPS = [100, 84, 68, 54, 42, 32];

/** Stepped toward the text colour, so the tail keeps its contrast in both modes. */
function sliceFill(index: number): string {
  const step = PIE_STEPS[index % PIE_STEPS.length] ?? 32;
  return `color-mix(in oklab, var(--chart-1) ${step}%, var(--foreground))`;
}

/** The window's spend by kind, as a share of the whole. */
function KindPie({ kinds, total }: { kinds: UsageKindTotals[]; total: number }) {
  const slices = kinds.filter((kind) => kind.cost > 0);
  const sweeps = slices.map((slice) => (slice.cost / total) * 360);
  const stops = sweeps.map((sweep, index) => {
    const from = sweeps.slice(0, index).reduce((sum, part) => sum + part, 0);
    return `${sliceFill(index)} ${from}deg ${from + sweep}deg`;
  });

  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div
        className="relative size-28 shrink-0 rounded-full xl:size-32"
        style={{
          background: stops.length > 0 ? `conic-gradient(${stops.join(", ")})` : "var(--muted)",
        }}
        aria-hidden
      >
        <div className="bg-card absolute inset-[26%] rounded-full" />
      </div>

      <ul className="space-y-1">
        {slices.map((slice, index) => (
          <li key={slice.kind} className="flex items-center gap-2 text-xs">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: sliceFill(index) }}
              aria-hidden
            />
            <span className="w-24 shrink-0 truncate">{KIND_LABELS[slice.kind]}</span>
            <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-[11px] tabular-nums">
              {share(slice.cost, total)}%
            </span>
            <span className="w-16 shrink-0 text-right font-mono tabular-nums">
              {formatCostRounded(slice.cost)}
            </span>
            <span className="text-muted-foreground w-9 shrink-0 text-right font-mono text-[11px] tabular-nums">
              {slice.calls}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BreakdownItem {
  label: string;
  cost: number;
  calls: number;
  globalCost: number;
  ownCost: number;
  tokens?: { input: number; output: number };
}

/** A set of lines measured against one total, under the columns they fill. */
function Breakdown({ items, total }: { items: BreakdownItem[]; total: number }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 shrink-0 text-[10px] md:w-24" />
        <span className="min-w-0 flex-1" />
        <span className="text-muted-foreground w-16 shrink-0 text-right text-[10px]">cost</span>
        <span className="text-muted-foreground w-9 shrink-0 text-right text-[10px]">calls</span>
      </div>
      {items.map((item) => (
        <BreakdownRow key={item.label} item={item} scale={total} />
      ))}
    </div>
  );
}

/** One line of a breakdown: a bar of ours against theirs, the money, the calls. */
function BreakdownRow({ item, scale }: { item: BreakdownItem; scale: number }) {
  const { label, cost, calls, globalCost, ownCost, tokens } = item;
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 shrink-0 md:w-24">
        <div className="truncate text-xs">{label}</div>
        {tokens ? (
          <div className="text-muted-foreground text-[10px] leading-tight tabular-nums">
            {formatTokens(tokens.input)} in · {formatTokens(tokens.output)} out
          </div>
        ) : null}
      </div>

      <div className="bg-muted flex h-2 min-w-0 flex-1 overflow-hidden rounded-full">
        {globalCost > 0 ? (
          <div
            className={cn("h-full", OURS_FILL)}
            style={{ width: `${percent(globalCost, scale)}%` }}
          />
        ) : null}
        {ownCost > 0 ? (
          <div
            className={cn("h-full", THEIRS_FILL)}
            style={{ width: `${percent(ownCost, scale)}%` }}
          />
        ) : null}
      </div>

      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
        {formatCostRounded(cost)}
      </span>
      <span className="text-muted-foreground w-9 shrink-0 text-right font-mono text-[11px] tabular-nums">
        {calls}
      </span>
    </div>
  );
}

/** Spend per day across the window, one bar per day, scaled to the busiest. */
function DailyBars({ daily, height = "h-14" }: { daily: UsageDay[]; height?: string }) {
  const busiest = daily.reduce((max, day) => Math.max(max, day.cost), 0);
  const first = daily[0];
  const last = daily[daily.length - 1];

  return (
    <div className="space-y-1">
      <div className={cn("border-border/50 flex items-end gap-px border-b pb-px", height)}>
        {daily.map((day) => (
          <div
            key={day.date}
            className="flex h-full flex-1 items-end"
            title={`${day.date} · ${formatCost(day.cost)} · ${day.calls} calls`}
          >
            <div
              className={cn("w-full rounded-t-sm", OURS_FILL)}
              style={{ height: `${barHeight(day.cost, busiest)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
        <span>{first ? DAY_FORMAT.format(new Date(first.date)) : null}</span>
        <span>{last ? DAY_FORMAT.format(new Date(last.date)) : null}</span>
      </div>
    </div>
  );
}

function LoadingLine() {
  return (
    <div className="px-4 py-6">
      <Loader2 className="text-muted-foreground size-4 animate-spin" />
    </div>
  );
}

/** A slice's share, kept to a decimal while it is under a percent. */
function share(value: number, total: number): string {
  if (total <= 0) return "0";
  const part = (value / total) * 100;
  return part >= 10 ? String(Math.round(part)) : part.toFixed(1);
}

function percent(value: number, scale: number): number {
  if (scale <= 0 || value <= 0) return 0;
  // A sliver stays visible.
  return Math.max((value / scale) * 100, 0.4);
}

function barHeight(value: number, busiest: number): number {
  if (busiest <= 0 || value <= 0) return 0;
  return Math.max((value / busiest) * 100, 2);
}
