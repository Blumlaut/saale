"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { useState } from "react";
import { formatCostRounded, formatTokens } from "@/lib/format";
import type { UsageDay, UsageKindTotals } from "@/lib/admin/usage";
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

/** Global takes the accent, local the grey, on every mark in the page. */
const GLOBAL_COLOR = "var(--chart-1)";
const LOCAL_COLOR = "var(--chart-2)";

/** Orange leads, grays follow, as the palette prescribes. */
const SLICE_FILLS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--muted-foreground)",
];

const TICK = { fill: "var(--muted-foreground)", fontSize: 10 } as const;

const DAY_TICK = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_FULL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Spend per day, global under local. Hovering a day gives its numbers. */
export function DailyChart({
  daily,
  height = "h-48",
  axis = true,
}: {
  daily: UsageDay[];
  height?: string;
  /** A y scale, for the page's chart; the detail's small chart leaves it out. */
  axis?: boolean;
}) {
  const peak = daily.reduce((max, day) => Math.max(max, day.cost), 0);

  return (
    <div className={cn("w-full", height)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={daily} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          {axis ? (
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          ) : null}
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => DAY_TICK.format(new Date(value))}
            tick={TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={axis ? 48 : 56}
          />
          {axis ? (
            <YAxis
              tickFormatter={(value: number) => costTick(value, peak)}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              width={52}
            />
          ) : null}
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            content={(props) => <DayTooltip {...props} />}
          />
          <Area
            type="monotone"
            dataKey="globalCost"
            name="Global"
            stackId="day"
            stroke={GLOBAL_COLOR}
            fill={GLOBAL_COLOR}
            fillOpacity={0.3}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="ownCost"
            name="Local"
            stackId="day"
            stroke={LOCAL_COLOR}
            fill={LOCAL_COLOR}
            fillOpacity={0.25}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function DayTooltip({ active, payload }: TooltipContentProps) {
  const day = payload?.[0]?.payload as UsageDay | undefined;
  if (!active || !day) return null;

  return (
    <TooltipShell title={`${DAY_FULL.format(new Date(day.date))} · ${day.calls} calls`}>
      <TooltipRow color={GLOBAL_COLOR} label="Global" value={money(day.globalCost)} />
      <TooltipRow color={LOCAL_COLOR} label="Local" value={money(day.ownCost)} />
      <div className="border-border/50 mt-1 flex items-baseline justify-between gap-4 border-t pt-1">
        <span className="text-muted-foreground">Total</span>
        <span className="tabular-nums">{money(day.cost)}</span>
      </div>
    </TooltipShell>
  );
}

/**
 * The window's spend by kind. Hovering a slice names it in the line under the
 * legend, so the numbers stay put instead of following the cursor.
 */
export function KindDonut({
  kinds,
  total,
  size = "size-32",
  tokens = false,
}: {
  kinds: UsageKindTotals[];
  total: number;
  size?: string;
  /** Show each kind's tokens, for an account's own breakdown. */
  tokens?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const slices = kinds.filter((kind) => kind.cost > 0);
  const active = hovered === null ? null : slices[hovered];

  return (
    <div className="space-y-3" onMouseLeave={() => setHovered(null)}>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <div className={cn("relative shrink-0", size)}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="cost"
                nameKey="kind"
                innerRadius="62%"
                outerRadius="96%"
                stroke="none"
                isAnimationActive={false}
                onMouseEnter={(_slice, index) => setHovered(index)}
              >
                {slices.map((slice, index) => (
                  <Cell
                    key={slice.kind}
                    fill={sliceFill(index)}
                    fillOpacity={hovered === null || hovered === index ? 1 : 0.4}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>

        <ul className="w-full max-w-md min-w-0 space-y-1.5">
          {slices.map((slice, index) => (
            <li
              key={slice.kind}
              className={cn(
                "flex items-center gap-2 text-xs transition-opacity duration-150",
                hovered !== null && hovered !== index && "opacity-50",
              )}
            >
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ background: sliceFill(index) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{KIND_LABELS[slice.kind]}</span>
              <span className="text-muted-foreground w-10 shrink-0 text-right text-[11px] tabular-nums">
                {percent(slice.cost, total)}
              </span>
              {tokens ? (
                <span className="text-muted-foreground w-14 shrink-0 text-right text-[11px] tabular-nums">
                  {formatTokens(slice.inputTokens + slice.outputTokens)}
                </span>
              ) : null}
              <span className="w-16 shrink-0 text-right tabular-nums">
                {formatCostRounded(slice.cost)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-muted-foreground truncate text-[11px] tabular-nums">
        {active
          ? `${KIND_LABELS[active.kind]} · Global ${formatCostRounded(active.globalCost)} · Local ${formatCostRounded(active.ownCost)} · ${active.calls} calls · ${formatCostRounded(active.cost)}`
          : `${slices.length} types · ${formatCostRounded(total)}`}
      </p>
    </div>
  );
}

function TooltipShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-popover border-border min-w-36 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-muted-foreground mb-1 text-[10px]">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
        <span className="text-muted-foreground">{label}</span>
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Money in a tooltip: cents, and four decimals only when the cents are zero. */
function money(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(value >= 0.01 ? 2 : 4)}`;
}

/** Axis money: whole dollars across the scale, cents when the scale is under one. */
function costTick(value: number, peak: number): string {
  return `$${peak >= 1 ? Math.round(value) : value.toFixed(2)}`;
}

/** A slice's share of the whole, written for a reader. */
function percent(value: number, total: number): string {
  const part = total > 0 ? (value / total) * 100 : 0;
  return `${part >= 10 ? Math.round(part) : part.toFixed(1)}%`;
}

function sliceFill(index: number): string {
  return SLICE_FILLS[index % SLICE_FILLS.length] ?? "var(--chart-5)";
}
