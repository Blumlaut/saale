"use client";

import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import {
  Server,
  Terminal,
  NotebookPen,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Loader2,
  CheckCircle,
  Key,
  Lock,
  Plus,
  Trash2,
  FileText,
  PenLine,
} from "lucide-react";
import { useState, useMemo } from "react";
import type { ToolCallData } from "./types";

/** Max characters before truncation. */
const MAX_NAME = 24;
const MAX_HOST = 32;
const MAX_COMMAND = 60;
const MAX_TITLE = 40;
const MAX_OUTPUT = 80;
const MAX_MACHINE = 20;
const MAX_PATH = 48;
const MAX_PREVIEW = 100;

/**
 * Structured metadata embedded in infra tool results.
 */
interface InfraListMachinesMeta {
  type: "infra_list_machines";
  count: number;
  machines: InfraMachineEntry[];
}

interface InfraExecMeta {
  type: "infra_exec";
  machineId: string;
  machineName: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

interface InfraNotesListMeta {
  type: "infra_notes_list";
  machineId: string;
  machineName: string;
  count: number;
  notes: InfraNoteEntry[];
}

interface InfraAddMachineMeta {
  type: "infra_add_machine";
  machineId: string;
  machineName: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
}

interface InfraRemoveMachineMeta {
  type: "infra_remove_machine";
  machineId: string;
  machineName: string;
}

interface InfraWriteFileMeta {
  type: "infra_write_file";
  machineId: string;
  machineName: string;
  path: string;
  ok: boolean;
}

interface InfraNotesGetMeta {
  type: "infra_notes_get";
  machineId: string;
  machineName: string;
  noteId: string;
  noteTitle: string;
  noteCategory: string;
  contentPreview: string;
}

interface InfraNotesUpsertMeta {
  type: "infra_notes_upsert";
  machineId: string;
  machineName: string;
  noteId: string;
  noteTitle: string;
  noteCategory: string;
  isUpdate: boolean;
}

interface InfraNotesDeleteMeta {
  type: "infra_notes_delete";
  machineId: string;
  machineName: string;
  noteId: string;
  noteTitle: string;
}

interface InfraMachineEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  noteCount: number;
}

interface InfraNoteEntry {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
}

type InfraMeta =
  | InfraListMachinesMeta
  | InfraExecMeta
  | InfraNotesListMeta
  | InfraAddMachineMeta
  | InfraRemoveMachineMeta
  | InfraWriteFileMeta
  | InfraNotesGetMeta
  | InfraNotesUpsertMeta
  | InfraNotesDeleteMeta;

/**
 * Extract _saaleInfraMeta from a tool result string.
 */
function extractInfraMeta(result: string | undefined): InfraMeta | null {
  if (!result) return null;

  const looseIdx = result.lastIndexOf('"_saaleInfraMeta"');
  if (looseIdx === -1) return null;

  const openBrace = result.lastIndexOf("{", looseIdx);
  if (openBrace === -1) return null;

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < result.length; i++) {
    if (result[i] === "{") depth++;
    else if (result[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return null;

  try {
    return JSON.parse(result.slice(openBrace, closeBrace + 1))._saaleInfraMeta as InfraMeta;
  } catch {
    return null;
  }
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Category badge color mapping.
 */
const CATEGORY_COLORS: Record<string, string> = {
  general: "bg-slate-500/10 text-slate-600",
  services: "bg-blue-500/10 text-blue-600",
  paths: "bg-amber-500/10 text-amber-600",
  credentials: "bg-red-500/10 text-red-600",
  quirks: "bg-orange-500/10 text-orange-600",
  config: "bg-purple-500/10 text-purple-600",
};

// ─── Machine row (reused in list) ───────────────────────────────────

function MachineRow({ machine }: { machine: InfraMachineEntry }) {
  const name = truncate(machine.name, MAX_NAME);
  const host = truncate(machine.host, MAX_HOST);
  const connectionStr = machine.port !== 22 ? `${host}:${machine.port}` : host;

  return (
    <div className="group hover:bg-accent/60 flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors">
      <Server className="text-muted-foreground h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground/90 text-xs font-medium">{name}</span>
          <span className="text-muted-foreground/60 text-[11px]">
            {machine.username}@{connectionStr}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {machine.authMethod === "key" ? (
            <Key className="text-muted-foreground/60 h-3 w-3" />
          ) : (
            <Lock className="text-muted-foreground/60 h-3 w-3" />
          )}
          <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
            {machine.authMethod}
          </Badge>
          {machine.noteCount > 0 && (
            <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
              {machine.noteCount} note{machine.noteCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Note row (reused in list) ──────────────────────────────────────

function NoteRow({ note }: { note: InfraNoteEntry }) {
  const title = truncate(note.title, MAX_TITLE);
  const category = note.category ?? "general";
  const date = formatRelativeDate(note.updatedAt);
  const colorClass = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.general;

  return (
    <div className="group hover:bg-accent/60 flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors">
      <NotebookPen className="text-muted-foreground h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 truncate text-xs font-medium">{title}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <Badge
            variant="secondary"
            className={cn("rounded px-1 py-0 text-[10px] font-normal", colorClass)}
          >
            {category}
          </Badge>
          <span className="text-muted-foreground/60 text-[10px]">{date}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Status badge helper ────────────────────────────────────────────

function StatusBadge({
  toolCall,
  icon,
  label,
}: {
  toolCall: ToolCallData;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "ml-auto rounded-full px-1.5 py-0 text-[10px]",
        toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
        toolCall.status === "completed" && "bg-green-500/10 text-green-600",
        (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
      )}
    >
      {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
      {toolCall.status === "completed" && icon}
      {(toolCall.status === "error" || toolCall.error) && (
        <AlertCircle className="mr-1 h-2.5 w-2.5" />
      )}
      {label}
    </Badge>
  );
}

// ─── infra_list_machines ────────────────────────────────────────────

function InfraListMachinesCard({
  meta,
  toolCall,
}: {
  meta: InfraListMachinesMeta;
  toolCall: ToolCallData;
}) {
  const [expanded, setExpanded] = useState(false);
  const maxVisible = 3;
  const visibleMachines = meta.machines.slice(0, expanded ? meta.machines.length : maxVisible);
  const hasMore = meta.machines.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Server className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Machines</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<Server className="mr-1 h-2.5 w-2.5" />}
          label={`${meta.count} machine${meta.count !== 1 ? "s" : ""}`}
        />
      </div>

      {meta.machines.length > 0 ? (
        <div className="border-border/30 border-t px-1.5 py-1">
          <div className="space-y-0.5">
            {visibleMachines.map((machine) => (
              <MachineRow key={machine.id} machine={machine} />
            ))}
          </div>

          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronDown className="h-3 w-3" />
              Show {meta.machines.length - maxVisible} more
            </button>
          )}

          {hasMore && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronRight className="h-3 w-3" />
              Show less
            </button>
          )}
        </div>
      ) : (
        <div className="border-border/30 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-xs">No machines registered</p>
        </div>
      )}
    </div>
  );
}

// ─── infra_exec ─────────────────────────────────────────────────────

function InfraExecCard({ meta, toolCall }: { meta: InfraExecMeta; toolCall: ToolCallData }) {
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const command = truncate(meta.command, MAX_COMMAND);
  const success = meta.exitCode === 0 && !meta.timedOut;
  const stdoutPreview = truncate(meta.stdout.split("\n")[0] ?? "", MAX_OUTPUT);
  const stderrPreview = truncate(meta.stderr.split("\n")[0] ?? "", MAX_OUTPUT);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Terminal className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Executed</span>
        <span className="text-muted-foreground font-mono text-xs">{command}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={
            success ? (
              <CheckCircle className="mr-1 h-2.5 w-2.5" />
            ) : (
              <AlertCircle className="mr-1 h-2.5 w-2.5" />
            )
          }
          label={
            meta.timedOut
              ? "timed out"
              : toolCall.status === "running"
                ? "running"
                : meta.exitCode !== null
                  ? `exit ${meta.exitCode}`
                  : "no exit code"
          }
        />
      </div>

      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Server className="text-muted-foreground/60 h-3 w-3" />
          <span className="text-muted-foreground text-[11px]">{machineName}</span>
          {meta.truncated && (
            <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
              truncated
            </Badge>
          )}
        </div>

        {(stdoutPreview || stderrPreview) && (
          <div className="bg-muted mt-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed dark:bg-white/5">
            {stderrPreview && (
              <div className="text-red-700 dark:text-red-400/80">{stderrPreview}</div>
            )}
            {stdoutPreview && (
              <div className="text-green-700 dark:text-green-400/80">{stdoutPreview}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── infra_notes_list ───────────────────────────────────────────────

function InfraNotesListCard({
  meta,
  toolCall,
}: {
  meta: InfraNotesListMeta;
  toolCall: ToolCallData;
}) {
  const [expanded, setExpanded] = useState(false);
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const maxVisible = 3;
  const visibleNotes = meta.notes.slice(0, expanded ? meta.notes.length : maxVisible);
  const hasMore = meta.notes.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <NotebookPen className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Machine notes</span>
        <span className="text-muted-foreground truncate text-xs">{machineName}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<NotebookPen className="mr-1 h-2.5 w-2.5" />}
          label={`${meta.count} note${meta.count !== 1 ? "s" : ""}`}
        />
      </div>

      {meta.notes.length > 0 ? (
        <div className="border-border/30 border-t px-1.5 py-1">
          <div className="space-y-0.5">
            {visibleNotes.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </div>

          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronDown className="h-3 w-3" />
              Show {meta.notes.length - maxVisible} more
            </button>
          )}

          {hasMore && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronRight className="h-3 w-3" />
              Show less
            </button>
          )}
        </div>
      ) : (
        <div className="border-border/30 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-xs">No notes for this machine</p>
        </div>
      )}
    </div>
  );
}

// ─── infra_add_machine ──────────────────────────────────────────────

function InfraAddMachineCard({
  meta,
  toolCall,
}: {
  meta: InfraAddMachineMeta;
  toolCall: ToolCallData;
}) {
  const name = truncate(meta.machineName, MAX_NAME);
  const host = truncate(meta.host, MAX_HOST);
  const connectionStr = meta.port !== 22 ? `${host}:${meta.port}` : host;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Plus className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Added machine</span>
        <span className="text-foreground/90 text-xs font-medium">{name}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<CheckCircle className="mr-1 h-2.5 w-2.5" />}
          label="added"
        />
      </div>

      <div className="border-border/30 border-t px-1.5 py-1">
        <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
          <Server className="text-muted-foreground h-4 w-4 shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground/60 text-[11px]">
                {meta.username}@{connectionStr}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              {meta.authMethod === "key" ? (
                <Key className="text-muted-foreground/60 h-3 w-3" />
              ) : (
                <Lock className="text-muted-foreground/60 h-3 w-3" />
              )}
              <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
                {meta.authMethod}
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── infra_remove_machine ───────────────────────────────────────────

function InfraRemoveMachineCard({
  meta,
  toolCall,
}: {
  meta: InfraRemoveMachineMeta;
  toolCall: ToolCallData;
}) {
  const name = truncate(meta.machineName, MAX_NAME);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Trash2 className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Removed machine</span>
        <span className="text-foreground/90 text-xs font-medium">{name}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<CheckCircle className="mr-1 h-2.5 w-2.5" />}
          label="removed"
        />
      </div>
    </div>
  );
}

// ─── infra_write_file ───────────────────────────────────────────────

function InfraWriteFileCard({
  meta,
  toolCall,
}: {
  meta: InfraWriteFileMeta;
  toolCall: ToolCallData;
}) {
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const path = truncate(meta.path, MAX_PATH);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileText className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Wrote file</span>
        <span className="text-muted-foreground font-mono text-xs">{path}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={
            meta.ok ? (
              <CheckCircle className="mr-1 h-2.5 w-2.5" />
            ) : (
              <AlertCircle className="mr-1 h-2.5 w-2.5" />
            )
          }
          label={meta.ok ? "ok" : "failed"}
        />
      </div>

      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Server className="text-muted-foreground/60 h-3 w-3" />
          <span className="text-muted-foreground text-[11px]">{machineName}</span>
        </div>
      </div>
    </div>
  );
}

// ─── infra_notes_get ────────────────────────────────────────────────

function InfraNotesGetCard({
  meta,
  toolCall,
}: {
  meta: InfraNotesGetMeta;
  toolCall: ToolCallData;
}) {
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const title = truncate(meta.noteTitle, MAX_TITLE);
  const category = meta.noteCategory ?? "general";
  const preview = truncate(meta.contentPreview, MAX_PREVIEW);
  const colorClass = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.general;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileText className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Read note</span>
        <span className="text-foreground/90 truncate text-xs font-medium">{title}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<FileText className="mr-1 h-2.5 w-2.5" />}
          label={category}
        />
      </div>

      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Server className="text-muted-foreground/60 h-3 w-3" />
          <span className="text-muted-foreground text-[11px]">{machineName}</span>
          <Badge
            variant="secondary"
            className={cn("rounded px-1 py-0 text-[10px] font-normal", colorClass)}
          >
            {category}
          </Badge>
        </div>
        {preview && (
          <p className="text-muted-foreground/70 mt-1.5 line-clamp-2 text-[11px] leading-relaxed">
            {preview}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── infra_notes_upsert ─────────────────────────────────────────────

function InfraNotesUpsertCard({
  meta,
  toolCall,
}: {
  meta: InfraNotesUpsertMeta;
  toolCall: ToolCallData;
}) {
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const title = truncate(meta.noteTitle, MAX_TITLE);
  const category = meta.noteCategory ?? "general";
  const colorClass = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.general;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <PenLine className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">{meta.isUpdate ? "Updated note" : "Saved note"}</span>
        <span className="text-foreground/90 truncate text-xs font-medium">{title}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<CheckCircle className="mr-1 h-2.5 w-2.5" />}
          label={category}
        />
      </div>

      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Server className="text-muted-foreground/60 h-3 w-3" />
          <span className="text-muted-foreground text-[11px]">{machineName}</span>
          <Badge
            variant="secondary"
            className={cn("rounded px-1 py-0 text-[10px] font-normal", colorClass)}
          >
            {category}
          </Badge>
        </div>
      </div>
    </div>
  );
}

// ─── infra_notes_delete ─────────────────────────────────────────────

function InfraNotesDeleteCard({
  meta,
  toolCall,
}: {
  meta: InfraNotesDeleteMeta;
  toolCall: ToolCallData;
}) {
  const machineName = truncate(meta.machineName, MAX_MACHINE);
  const title = truncate(meta.noteTitle, MAX_TITLE);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Trash2 className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Deleted note</span>
        <span className="text-foreground/90 truncate text-xs font-medium">{title}</span>
        <StatusBadge
          toolCall={toolCall}
          icon={<CheckCircle className="mr-1 h-2.5 w-2.5" />}
          label="deleted"
        />
      </div>

      <div className="border-border/30 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Server className="text-muted-foreground/60 h-3 w-3" />
          <span className="text-muted-foreground text-[11px]">{machineName}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Router ─────────────────────────────────────────────────────────

/**
 * Main exported component that routes to the correct card type.
 */
export function InfraToolCard({ toolCall }: { toolCall: ToolCallData }) {
  const meta = useMemo(() => extractInfraMeta(toolCall.result), [toolCall.result]);

  if (!meta) {
    if (toolCall.status === "running") {
      return (
        <div className="liquid-glass-inner rounded-xl">
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />
            <span className="text-muted-foreground text-xs">{toolCall.name}</span>
          </div>
        </div>
      );
    }
    return null;
  }

  switch (meta.type) {
    case "infra_exec":
      return <InfraExecCard meta={meta} toolCall={toolCall} />;
    case "infra_notes_list":
      return <InfraNotesListCard meta={meta} toolCall={toolCall} />;
    case "infra_add_machine":
      return <InfraAddMachineCard meta={meta} toolCall={toolCall} />;
    case "infra_remove_machine":
      return <InfraRemoveMachineCard meta={meta} toolCall={toolCall} />;
    case "infra_write_file":
      return <InfraWriteFileCard meta={meta} toolCall={toolCall} />;
    case "infra_notes_get":
      return <InfraNotesGetCard meta={meta} toolCall={toolCall} />;
    case "infra_notes_upsert":
      return <InfraNotesUpsertCard meta={meta} toolCall={toolCall} />;
    case "infra_notes_delete":
      return <InfraNotesDeleteCard meta={meta} toolCall={toolCall} />;
    default:
      return <InfraListMachinesCard meta={meta} toolCall={toolCall} />;
  }
}
