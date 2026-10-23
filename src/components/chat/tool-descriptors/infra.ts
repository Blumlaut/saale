import {
  Download,
  FileText,
  Key,
  Lock,
  NotebookPen,
  PenLine,
  Plus,
  Server,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { formatFileSize } from "@/lib/utils";
import { formatRelativeDate, plural, truncate } from "@/lib/format";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { isToolCallInProgress, toolStatus } from "../tool-status";
import type {
  ToolCardBlock,
  ToolCardModel,
  ToolDescriptor,
  ToolFact,
  ToolRowModel,
  ToolTone,
} from "../tool-card-model";
import type { ToolCallData } from "../types";

/** Max characters before truncation. */
const MAX_NAME = 24;
const MAX_HOST = 32;
const MAX_COMMAND = 60;
const MAX_TITLE = 40;
const MAX_MACHINE = 20;
const MAX_PATH = 48;
const MAX_PREVIEW = 100;

/**
 * Structured metadata embedded in infra tool results.
 * Extracted from the `_saaleInfraMeta` block appended by the tools.
 */
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

interface InfraReadFileMeta {
  type: "infra_read_file";
  machineId: string;
  machineName: string;
  path: string;
  truncated: boolean;
  totalLines?: number;
  preview: string;
  imageMimeType?: string;
}

interface InfraEditFileMeta {
  type: "infra_edit_file";
  machineId: string;
  machineName: string;
  path: string;
  replacements: number;
  firstChangedLine?: number;
  diff: string;
}

interface InfraTransferMeta {
  type: "infra_download_file" | "infra_upload_file";
  machineId: string;
  machineName: string;
  path: string;
  localPath: string;
  size: number;
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

type InfraMeta =
  | InfraListMachinesMeta
  | InfraExecMeta
  | InfraNotesListMeta
  | InfraAddMachineMeta
  | InfraRemoveMachineMeta
  | InfraWriteFileMeta
  | InfraReadFileMeta
  | InfraEditFileMeta
  | InfraTransferMeta
  | InfraNotesGetMeta
  | InfraNotesUpsertMeta
  | InfraNotesDeleteMeta;

/** Badge hue per machine-note category. */
const NOTE_TONE: Record<string, ToolTone> = {
  general: "neutral",
  services: "info",
  paths: "warn",
  credentials: "danger",
  quirks: "accent",
  config: "violet",
};

/** Every card for a registered machine's tools, behind the `infra_` prefix. */
export const infraToolDescriptor: ToolDescriptor = {
  prefixes: ["infra_"],
  describe(toolCall): ToolCardModel | null {
    const meta = extractToolMeta<InfraMeta>(toolCall.result);
    if (!meta) return null;

    switch (meta.type) {
      case "infra_exec":
        return execModel(toolCall, meta);
      case "infra_list_machines":
        return {
          icon: Server,
          title: "Machines",
          status: toolStatus(toolCall, plural(meta.count, "machine", "machines")),
          defaultOpen: true,
          blocks: [
            {
              kind: "rows",
              items: meta.machines.map(machineRow),
              empty: "No machines registered",
            },
          ],
        };
      case "infra_notes_list":
        return {
          icon: NotebookPen,
          title: "Machine notes",
          detail: machineName(meta.machineName),
          status: toolStatus(toolCall, plural(meta.count, "note", "notes")),
          defaultOpen: true,
          blocks: [
            {
              kind: "rows",
              items: meta.notes.map(noteRow),
              empty: "No notes for this machine",
            },
          ],
        };
      case "infra_add_machine":
        return {
          icon: Plus,
          title: "Added machine",
          detail: truncate(meta.machineName, MAX_NAME),
          status: toolStatus(toolCall, "added"),
          blocks: [
            {
              kind: "facts",
              items: [
                {
                  icon: meta.authMethod === "key" ? Key : Lock,
                  text: `${meta.username}@${connection(meta.host, meta.port)}`,
                  mono: true,
                  badge: { text: meta.authMethod },
                },
              ],
            },
          ],
        };
      case "infra_remove_machine":
        return {
          icon: Trash2,
          title: "Removed machine",
          detail: truncate(meta.machineName, MAX_NAME),
          status: toolStatus(toolCall, "removed"),
        };
      case "infra_write_file":
        return {
          icon: FileText,
          title: "Wrote file",
          detail: truncate(meta.path, MAX_PATH),
          status: toolStatus(toolCall, meta.ok ? "ok" : "failed", meta.ok ? "success" : "danger"),
          blocks: [machineFact(meta.machineName)],
        };
      case "infra_read_file":
        return {
          icon: FileText,
          title: meta.imageMimeType ? "Read image" : "Read file",
          detail: truncate(meta.path, MAX_PATH),
          status: toolStatus(toolCall, "read"),
          blocks: [
            machineFact(meta.machineName, {
              // The caveat belongs with the details, the way an exit code does:
              // the header badge stays the call's status.
              ...(meta.truncated ? { badge: { text: "truncated", tone: "warn" as const } } : {}),
              // A truncated read must not claim a complete line count.
              ...(!meta.truncated && meta.totalLines !== undefined
                ? { note: plural(meta.totalLines, "line", "lines") }
                : {}),
            }),
            ...(meta.preview && !meta.imageMimeType
              ? [
                  {
                    kind: "text" as const,
                    text: truncate(meta.preview, MAX_PREVIEW),
                    mono: true,
                    clamp: true,
                  },
                ]
              : []),
          ],
        };
      case "infra_edit_file": {
        const lines = meta.diff ? meta.diff.split("\n") : [];
        return {
          icon: PenLine,
          title: "Edited file",
          detail: truncate(meta.path, MAX_PATH),
          status: toolStatus(toolCall, plural(meta.replacements, "edit", "edits")),
          blocks: [
            ...(lines.length > 0 ? [{ kind: "diff" as const, lines }] : []),
            machineFact(meta.machineName, {
              ...(meta.firstChangedLine !== undefined
                ? { note: `line ${meta.firstChangedLine}` }
                : {}),
            }),
          ],
        };
      }
      case "infra_download_file":
      case "infra_upload_file": {
        const downloading = meta.type === "infra_download_file";
        return {
          icon: downloading ? Download : Upload,
          title: downloading ? "Downloaded" : "Uploaded",
          detail: truncate(meta.path, MAX_PATH),
          status: toolStatus(toolCall, formatFileSize(meta.size)),
          blocks: [
            {
              kind: "facts",
              items: [
                { icon: Server, text: machineName(meta.machineName) },
                { icon: FileText, text: truncate(meta.localPath, MAX_PATH), mono: true },
              ],
            },
          ],
        };
      }
      case "infra_notes_get":
        return {
          icon: FileText,
          title: "Read note",
          detail: truncate(meta.noteTitle, MAX_TITLE),
          status: toolStatus(toolCall, "read"),
          blocks: [
            noteFact(meta.machineName, meta.noteCategory),
            ...(meta.contentPreview
              ? [
                  {
                    kind: "text" as const,
                    text: truncate(meta.contentPreview, MAX_PREVIEW),
                    clamp: true,
                  },
                ]
              : []),
          ],
        };
      case "infra_notes_upsert":
        return {
          icon: PenLine,
          title: meta.isUpdate ? "Updated note" : "Saved note",
          detail: truncate(meta.noteTitle, MAX_TITLE),
          status: toolStatus(toolCall, meta.isUpdate ? "updated" : "saved"),
          blocks: [noteFact(meta.machineName, meta.noteCategory)],
        };
      case "infra_notes_delete":
        return {
          icon: Trash2,
          title: "Deleted note",
          detail: truncate(meta.noteTitle, MAX_TITLE),
          status: toolStatus(toolCall, "deleted"),
          blocks: [machineFact(meta.machineName)],
        };
      default:
        return null;
    }
  },
};

function execModel(toolCall: ToolCallData, meta: InfraExecMeta): ToolCardModel {
  const stdout = firstLine(meta.stdout);
  const stderr = firstLine(meta.stderr);
  const failed = execFailed(toolCall, meta);

  return {
    icon: Terminal,
    title: "Executed",
    detail: truncate(meta.command, MAX_COMMAND),
    status: execStatus(toolCall, meta),
    // A failure's reason is the whole point of the card, so never hide it.
    ...(failed ? { defaultOpen: true } : {}),
    blocks: [
      machineFact(meta.machineName, {
        ...(meta.truncated ? { badge: { text: "truncated", tone: "warn" as const } } : {}),
      }),
      ...(stdout || stderr ? [{ kind: "output" as const, stdout, stderr }] : []),
    ],
  };
}

/**
 * Whether a command failed. A non-zero exit is a failure even when the call
 * itself never errored, and it is what decides both the badge and whether the
 * card starts open.
 */
function execFailed(toolCall: ToolCallData, meta: InfraExecMeta): boolean {
  if (isToolCallInProgress(toolCall)) return false;
  return (
    meta.timedOut || (meta.exitCode !== null && meta.exitCode !== 0) || Boolean(toolCall.error)
  );
}

function execStatus(toolCall: ToolCallData, meta: InfraExecMeta) {
  // Not run yet, or still running: there is no exit to report.
  if (isToolCallInProgress(toolCall)) return toolStatus(toolCall);
  if (meta.timedOut) return toolStatus(toolCall, "timed out", "danger");
  if (meta.exitCode !== null) {
    return meta.exitCode === 0
      ? toolStatus(toolCall, "exit 0", "success")
      : toolStatus(toolCall, `exit ${meta.exitCode}`, "danger");
  }
  return toolStatus(toolCall);
}

function machineRow(machine: InfraMachineEntry): ToolRowModel {
  return {
    leading: { kind: "icon", icon: Server },
    title: truncate(machine.name, MAX_NAME),
    meta: [
      {
        kind: "text",
        text: `${machine.username}@${connection(machine.host, machine.port)}`,
        mono: true,
      },
      { kind: "badge", text: machine.authMethod },
      ...(machine.noteCount > 0
        ? [{ kind: "badge" as const, text: plural(machine.noteCount, "note", "notes") }]
        : []),
    ],
  };
}

function noteRow(note: InfraNoteEntry): ToolRowModel {
  return {
    leading: { kind: "icon", icon: NotebookPen },
    title: truncate(note.title, MAX_TITLE),
    meta: [
      { kind: "badge", text: note.category, tone: noteTone(note.category) },
      { kind: "text", text: formatRelativeDate(note.updatedAt) },
    ],
  };
}

/** One fact line naming the machine a call ran on. */
function machineFact(
  name: string,
  extra: { badge?: NonNullable<ToolFact["badge"]>; note?: string } = {},
): ToolCardBlock {
  return {
    kind: "facts",
    items: [{ icon: Server, text: machineName(name), ...extra }],
  };
}

/** One fact line naming the machine and the note's category. */
function noteFact(name: string, category: string): ToolCardBlock {
  return {
    kind: "facts" as const,
    items: [
      {
        icon: Server,
        text: machineName(name),
        badge: { text: category, tone: noteTone(category) },
      },
    ],
  };
}

function noteTone(category: string): ToolTone {
  return NOTE_TONE[category] ?? "neutral";
}

function machineName(name: string): string {
  return truncate(name, MAX_MACHINE);
}

/** "host" or "host:port". the default port stays implicit. */
function connection(host: string, port: number): string {
  return port !== 22 ? `${truncate(host, MAX_HOST)}:${port}` : truncate(host, MAX_HOST);
}

/** The first line of captured output. the card shows a preview, not a log. */
function firstLine(output: string): string {
  return output.split("\n")[0] ?? "";
}
