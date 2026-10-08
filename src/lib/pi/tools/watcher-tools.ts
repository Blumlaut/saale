import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import {
  createWatcher,
  deleteWatcher,
  previewConsent,
  serializeWatcher,
  updateWatcher,
  WatcherInputError,
} from "@/lib/watchers/manage";
import { previewScript, previewWatcherTick } from "@/lib/watchers/tick";

/**
 * Script watcher tools.
 *
 * A watcher is a durable, unattended capability: its script runs on a schedule
 * and can call the user's tools without anyone watching. So the tools that
 * create, change or run one default to asking the user — the approval card is
 * where the script is read before it becomes permanent — and nothing here can
 * approve a script on the user's behalf.
 */

/** How a script is expected to report. Repeated in the descriptions on purpose. */
const SCRIPT_CONTRACT = [
  "The script is an async function body run in a sandbox.",
  "Call tools as `await tools.<name>({...})`, keep state across ticks with `store(key, value)`",
  "and `load(key)`, and `return` something only when there is news:",
  "`undefined`/`null`/`false` means nothing happened and nobody is woken.",
  "Timers, `fetch`, `require` and `process` do not exist.",
].join(" ");

/** A tool result carrying one JSON document, which is what every tool here returns. */
function jsonResult(value: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}

/** A tick log entry, trimmed to what the model needs. */
function tickView(outcome: {
  status: string;
  value?: unknown;
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
}): Record<string, unknown> {
  return {
    status: outcome.status,
    value: outcome.value,
    reason: outcome.reason,
    output: outcome.output,
    durationMs: outcome.durationMs,
    toolCalls: outcome.callCount,
  };
}

export function createWatcherTools(userId: string, sessionId: string): ToolDefinition[] {
  return [
    // ─── watcher_list ───────────────────────────────────────────────────────
    defineTool({
      name: "watcher_list",
      label: "List Watchers",
      description:
        "List script watchers: the cheap poll jobs that run a script on a schedule and wake you only when it reports something. Shows cadence, approved tools, last outcome, and whether a script is waiting for the user's approval.",
      parameters: Type.Object({}),
      execute: async () => {
        const watchers = await prisma.scriptWatcher.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          include: { session: { select: { title: true } } },
        });

        return jsonResult({
          count: watchers.length,
          watchers: watchers.map((watcher) => {
            const serialized = serializeWatcher(watcher);
            return {
              id: serialized.id,
              name: serialized.name,
              cron: serialized.cronExpression,
              enabled: serialized.enabled,
              reportsTo: serialized.sessionId
                ? { chatId: serialized.sessionId, title: serialized.sessionTitle }
                : "no conversation (runs a standalone agent run)",
              approvedTools: serialized.grantedTools,
              unrestricted: serialized.grantAll,
              needsApproval: serialized.needsApproval,
              cooldownMinutes: serialized.cooldownMinutes,
              ticks: serialized.tickCount,
              fires: serialized.fireCount,
              lastTickAt: serialized.lastTickAt,
              lastError: serialized.lastError,
            };
          }),
        });
      },
    }),

    // ─── watcher_test ───────────────────────────────────────────────────────
    defineTool({
      name: "watcher_test",
      label: "Test Watcher Script",
      description: `Run a watcher script once and report what it returned, without scheduling it, recording a tick, or waking anyone. Use this to write and check a script before creating the watcher. ${SCRIPT_CONTRACT} Provide either \`script\` (draft, at any point), or \`watcherId\` to check a saved watcher.`,
      parameters: Type.Object({
        script: Type.Optional(
          Type.String({
            description: "A draft script to run. May be provided before the watcher exists.",
          }),
        ),
        watcherId: Type.Optional(
          Type.String({
            description: "Run a saved watcher's script instead (checks it against its approval).",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "The conversation the script will report into — scopes chat-aware tools. Defaults to this conversation.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        if (params.script && params.watcherId) {
          throw new Error("Provide either `script` or `watcherId`, not both.");
        }

        if (params.watcherId) {
          const watcher = await prisma.scriptWatcher.findFirst({
            where: { id: params.watcherId, userId },
            select: { id: true },
          });
          if (!watcher) throw new Error(`Watcher not found: ${params.watcherId}`);

          const outcome = await previewWatcherTick(params.watcherId);
          return jsonResult(tickView(outcome));
        }

        if (!params.script?.trim()) {
          throw new Error("Provide `script` to run, or `watcherId` to check a saved watcher.");
        }

        const targetSession = params.sessionId ?? sessionId;
        const consent = await previewConsent({
          userId,
          script: params.script,
          sessionId: targetSession,
        });
        const outcome = await previewScript({
          userId,
          script: params.script,
          sessionId: targetSession,
        });

        return jsonResult({
          ...tickView(outcome),
          // What creating this watcher would ask the user to approve.
          wouldNeedApprovalFor: consent.grantedTools,
          wouldBeAllowedEveryTool: consent.grantAll,
        });
      },
    }),

    // ─── watcher_create ─────────────────────────────────────────────────────
    defineTool({
      name: "watcher_create",
      label: "Create Watcher",
      description: `Create a script watcher: it runs a script on a cron schedule and wakes you only when the script returns something. Use it for anything you would otherwise poll for on a timer — checking a mailbox, a remote host, a feed — where running a full agent every few minutes would be wasteful. ${SCRIPT_CONTRACT} The user must confirm the script and the tools it may call before this happens; say what you are proposing and why.`,
      parameters: Type.Object({
        name: Type.String({ description: "Watcher name (max 100 chars, unique per user)." }),
        script: Type.String({ description: `The script body. ${SCRIPT_CONTRACT}` }),
        cronExpression: Type.String({
          description:
            "When to tick, as a 5-field cron expression (minute hour day month weekday), e.g. '*/10 * * * *'. Cron granularity is one minute.",
        }),
        sessionId: Type.Optional(
          Type.String({
            description:
              "Conversation to report into. Defaults to this conversation; omit only for a watcher that should run standalone.",
          }),
        ),
        wakePrompt: Type.Optional(
          Type.String({
            description:
              "Instructions for the agent when the watcher fires. The script's returned value is appended automatically.",
          }),
        ),
        description: Type.Optional(Type.String({ description: "What this watcher is for." })),
        cooldownMinutes: Type.Optional(
          Type.Number({
            description:
              "Minimum minutes between wakes. Use it to bound how often the watcher can spend tokens.",
          }),
        ),
        modelId: Type.Optional(
          Type.String({
            description: "Model override for a standalone wake (format 'provider:modelId').",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const created = await createWatcher({
            userId,
            fields: {
              name: params.name,
              script: params.script,
              cronExpression: params.cronExpression,
              sessionId: params.sessionId ?? sessionId,
              wakePrompt: params.wakePrompt,
              description: params.description,
              cooldownMinutes: params.cooldownMinutes,
              modelId: params.modelId,
            },
          });

          return jsonResult({
            created: true,
            id: created.id,
            name: created.name,
            approvedTools: created.grantedTools,
            unrestricted: created.grantAll,
            note: "The watcher now ticks on its schedule. It wakes you only when the script returns a value.",
          });
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }
      },
    }),

    // ─── watcher_update ─────────────────────────────────────────────────────
    defineTool({
      name: "watcher_update",
      label: "Update Watcher",
      description:
        "Update a watcher's script, cadence, target, wake instructions, cooldown or enabled state. Changing the script does not renew its tool approval: the watcher pauses until the user approves the new script, because an approval covers the script it was given for and nothing else. Tell the user when that happens.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
        script: Type.Optional(Type.String({ description: "New script body." })),
        cronExpression: Type.Optional(Type.String({ description: "New cron expression." })),
        name: Type.Optional(Type.String({ description: "New name." })),
        description: Type.Optional(Type.String({ description: "New description." })),
        sessionId: Type.Optional(Type.String({ description: "New target conversation id." })),
        wakePrompt: Type.Optional(Type.String({ description: "New wake instructions." })),
        cooldownMinutes: Type.Optional(Type.Number({ description: "New cooldown in minutes." })),
        modelId: Type.Optional(Type.String({ description: "New model override." })),
        enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the watcher." })),
      }),
      execute: async (_toolCallId, params) => {
        const fields: Record<string, unknown> = {};
        for (const key of [
          "script",
          "cronExpression",
          "name",
          "description",
          "sessionId",
          "wakePrompt",
          "cooldownMinutes",
          "modelId",
          "enabled",
        ]) {
          if (params[key as keyof typeof params] !== undefined) {
            fields[key] = params[key as keyof typeof params];
          }
        }

        if (Object.keys(fields).length === 0) {
          throw new Error("Provide at least one field to update.");
        }

        try {
          const updated = await updateWatcher({
            id: params.watcherId,
            userId,
            fields,
            // A tool call is not a human reading this script, so a changed script
            // waits for the user rather than re-earning its grant here.
            approveScript: false,
          });

          const watcher = await prisma.scriptWatcher.findUniqueOrThrow({
            where: { id: updated.id },
            select: { script: true, grantedTools: true, grantAll: true },
          });
          const consent = await previewConsent({ userId, script: watcher.script });

          return jsonResult({
            updated: true,
            id: updated.id,
            needsApproval: updated.needsApproval,
            ...(updated.needsApproval
              ? {
                  note: "The script changed, so the watcher is paused until the user approves it on the Watchers page.",
                  toolsItWillAskToApprove: consent.grantedTools,
                  unrestricted: consent.grantAll,
                }
              : {}),
          });
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }
      },
    }),

    // ─── watcher_ticks ──────────────────────────────────────────────────────
    defineTool({
      name: "watcher_ticks",
      label: "Watcher Tick Log",
      description:
        "Read a watcher's recent ticks — what its script returned, what it printed, and any error. This is how to see why a watcher is not reporting: a predicate that never matches looks the same as nothing happening.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
        limit: Type.Optional(Type.Number({ description: "How many ticks to read (default 10)." })),
      }),
      execute: async (_toolCallId, params) => {
        const watcher = await prisma.scriptWatcher.findFirst({
          where: { id: params.watcherId, userId },
          select: { id: true, name: true, enabled: true, lastError: true },
        });
        if (!watcher) throw new Error(`Watcher not found: ${params.watcherId}`);

        const ticks = await prisma.scriptWatcherTick.findMany({
          where: { watcherId: params.watcherId },
          orderBy: { createdAt: "desc" },
          take: Math.min(Math.max(params.limit ?? 10, 1), 50),
        });

        return jsonResult({
          watcher: watcher.name,
          enabled: watcher.enabled,
          lastError: watcher.lastError,
          ticks: ticks.map((tick) => ({
            at: tick.createdAt.toISOString(),
            status: tick.status,
            value: tick.value,
            error: tick.error,
            output: tick.output,
            durationMs: tick.durationMs,
            toolCalls: tick.callCount,
          })),
        });
      },
    }),

    // ─── watcher_delete ─────────────────────────────────────────────────────
    defineTool({
      name: "watcher_delete",
      label: "Delete Watcher",
      description: "Delete a script watcher and stop its ticks.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
      }),
      execute: async (_toolCallId, params) => {
        try {
          await deleteWatcher(params.watcherId, userId);
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }

        return jsonResult({ deleted: true, id: params.watcherId });
      },
    }),
  ];
}
