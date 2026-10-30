import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { prisma } from "@/lib/db";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  createWatcher,
  deleteWatcher,
  serializeWatcher,
  updateWatcher,
  WatcherInputError,
} from "@/lib/watchers/manage";
import { deliveryNote } from "@/lib/watchers/delivery";
import { previewScript, previewWatcherTick } from "@/lib/watchers/tick";

/**
 * Script watcher tools.
 *
 * A watcher is a durable, unattended capability: its script runs on a schedule
 * and can call the user's tools without anyone watching. Testing runs in a
 * sandbox without recording or waking anyone, and deleting only stops a tick the
 * user can recreate.
 */

/** How a script is expected to report. Repeated in the descriptions on purpose. */
const SCRIPT_CONTRACT = [
  "The script is an async function body run in a sandbox.",
  "Call tools as `await tools.<name>({...})`, keep state across ticks with `store(key, value)`",
  "and `load(key)`, and `return` something only when there is news:",
  "`undefined`/`null`/`false` means nothing happened and nobody is woken.",
  'Find a tool you cannot name with `searchTools("what you need")` inside the script',
  "(`ALL_TOOLS` lists every tool).",
  "A call resolves to the tool's value, so read its fields (`r.exitCode`, `r.stdout`).",
  "A script that should tell the user something itself calls `tools.telegram_send({ message })`",
  'during the run. with `deliver: "silent"` that is the whole delivery and no model is woken.',
  "Never match a marker against a whole result. it echoes the arguments it was called with ",
  "and never paste a result into the script text: keep it in a variable, or in `store()`.",
  "Timers, `fetch`, `require` and `process` do not exist.",
].join(" ");

/** One watcher as the list reports it. */
const watcherSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  cron: Type.String(),
  enabled: Type.Boolean(),
  /** "chat" | "silent" | "coder". */
  deliver: Type.String(),
  reportsTo: Type.Union([
    Type.Object({ chatId: Type.String(), title: Type.Union([Type.String(), Type.Null()]) }),
    Type.String(),
  ]),
  cooldownMinutes: Type.Union([Type.Integer(), Type.Null()]),
  ticks: Type.Integer(),
  fires: Type.Integer(),
  lastTickAt: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
});

const watcherListSchema = Type.Object({
  count: Type.Integer(),
  watchers: Type.Array(watcherSchema),
});

/** One watcher in full: every field `watcher_update` writes, plus its counters. */
const watcherDetailSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  script: Type.String(),
  cronExpression: Type.String(),
  enabled: Type.Boolean(),
  /** "chat" | "silent" | "coder". */
  deliver: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  sessionTitle: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Type.String(), Type.Null()]),
  projectName: Type.Union([Type.String(), Type.Null()]),
  worktreeMode: Type.String(),
  retentionMinutes: Type.Integer(),
  wakePrompt: Type.String(),
  modelId: Type.Union([Type.String(), Type.Null()]),
  cooldownMinutes: Type.Integer(),
  ticks: Type.Integer(),
  fires: Type.Integer(),
  lastTickAt: Type.Union([Type.String(), Type.Null()]),
  lastFiredAt: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  lastValue: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/** What one run of a script did. */
const runOutcomeSchema = Type.Object({
  status: Type.String(),
  value: Type.Optional(Type.Unknown()),
  reason: Type.Optional(Type.String()),
  output: Type.String(),
  durationMs: Type.Number(),
  toolCalls: Type.Integer(),
  /** The tools it called, which is how a silent watcher delivered. */
  tools: Type.Array(Type.String()),
});

const watcherTestSchema = Type.Object(runOutcomeSchema.properties);

const watcherCreateSchema = Type.Object({
  created: Type.Boolean(),
  id: Type.String(),
  name: Type.String(),
  note: Type.String(),
});

const watcherUpdateSchema = Type.Object({
  updated: Type.Boolean(),
  id: Type.String(),
  note: Type.String(),
});

const watcherTicksSchema = Type.Object({
  watcher: Type.String(),
  enabled: Type.Boolean(),
  lastError: Type.Union([Type.String(), Type.Null()]),
  ticks: Type.Array(
    Type.Object({
      at: Type.String(),
      status: Type.String(),
      /// JSON-encoded, as the log stores it.
      value: Type.Union([Type.String(), Type.Null()]),
      error: Type.Union([Type.String(), Type.Null()]),
      output: Type.Union([Type.String(), Type.Null()]),
      durationMs: Type.Number(),
      toolCalls: Type.Integer(),
      tools: Type.Array(Type.String()),
      /** The chat the fire was delivered into, when one was. */
      chatId: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

const watcherDeleteSchema = Type.Object({ deleted: Type.Boolean(), id: Type.String() });

/** A tick log entry, trimmed to what the model needs. */
function tickView(outcome: {
  status: string;
  value?: unknown;
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
  callNames: string[];
}): Static<typeof runOutcomeSchema> {
  return {
    status: outcome.status,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    output: outcome.output,
    durationMs: outcome.durationMs,
    toolCalls: outcome.callCount,
    tools: outcome.callNames,
  };
}

export function createWatcherTools(userId: string, sessionId: string): ToolDefinition[] {
  return [
    // ─── watcher_list ───────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_list",
      label: "List Watchers",
      description:
        "List script watchers: the cheap poll jobs that run a script on a schedule and wake you only when it reports something. Shows cadence, delivery target and last outcome. Read one in full, script included, with watcher_get.",
      parameters: Type.Object({}),
      outputSchema: watcherListSchema,
      execute: async () => {
        const watchers = await prisma.scriptWatcher.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          include: { session: { select: { title: true } }, project: { select: { name: true } } },
        });

        return {
          value: {
            count: watchers.length,
            watchers: watchers.map((watcher) => {
              const serialized = serializeWatcher(watcher);
              return {
                id: serialized.id,
                name: serialized.name,
                cron: serialized.cronExpression,
                enabled: serialized.enabled,
                deliver: serialized.deliver,
                reportsTo:
                  serialized.deliver === "coder"
                    ? `project ${serialized.projectName ?? serialized.projectId}`
                    : serialized.deliver === "silent"
                      ? "nothing (the script delivers it)"
                      : serialized.sessionId
                        ? { chatId: serialized.sessionId, title: serialized.sessionTitle }
                        : "nothing",
                cooldownMinutes: serialized.cooldownMinutes,
                ticks: serialized.tickCount,
                fires: serialized.fireCount,
                lastTickAt: serialized.lastTickAt,
                lastError: serialized.lastError,
              };
            }),
          },
        };
      },
    }),

    // ─── watcher_get ────────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_get",
      label: "Read Watcher",
      description:
        "Read one watcher in full: the script it runs, its cadence, delivery target, wake instructions, worktree mode, cooldown and model, plus what its last tick did. Everything watcher_update can change is here, so read a watcher you did not create before editing it.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
      }),
      outputSchema: watcherDetailSchema,
      execute: async (_toolCallId, params) => {
        const watcher = await prisma.scriptWatcher.findFirst({
          where: { id: params.watcherId, userId },
          include: { session: { select: { title: true } }, project: { select: { name: true } } },
        });
        if (!watcher) throw new Error(`Watcher not found: ${params.watcherId}`);

        const serialized = serializeWatcher(watcher);

        return {
          value: {
            id: serialized.id,
            name: serialized.name,
            description: serialized.description,
            script: serialized.script,
            cronExpression: serialized.cronExpression,
            enabled: serialized.enabled,
            deliver: serialized.deliver,
            sessionId: serialized.sessionId,
            sessionTitle: serialized.sessionTitle,
            projectId: serialized.projectId,
            projectName: serialized.projectName,
            worktreeMode: serialized.worktreeMode,
            retentionMinutes: serialized.retentionMinutes,
            wakePrompt: serialized.wakePrompt,
            modelId: serialized.modelId,
            cooldownMinutes: serialized.cooldownMinutes,
            ticks: serialized.tickCount,
            fires: serialized.fireCount,
            lastTickAt: serialized.lastTickAt,
            lastFiredAt: serialized.lastFiredAt,
            lastError: serialized.lastError,
            lastValue: serialized.lastValue,
            createdAt: serialized.createdAt,
            updatedAt: serialized.updatedAt,
          },
        };
      },
    }),

    // ─── watcher_test ───────────────────────────────────────────────────────
    defineStructuredTool({
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
            description: "Run a saved watcher's script instead.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "The conversation the script will report into. scopes chat-aware tools. Defaults to this conversation.",
          }),
        ),
      }),
      outputSchema: watcherTestSchema,
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
          return { value: tickView(outcome) };
        }

        if (!params.script?.trim()) {
          throw new Error("Provide `script` to run, or `watcherId` to check a saved watcher.");
        }

        const outcome = await previewScript({
          userId,
          script: params.script,
          sessionId: params.sessionId ?? sessionId,
        });

        return { value: tickView(outcome) };
      },
    }),

    // ─── watcher_create ─────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_create",
      label: "Create Watcher",
      description: `Create a script watcher: it runs a script on a cron schedule and does something with what the script returns. Use it for anything you would otherwise poll for on a timer. checking a mailbox, a remote host, a feed, a git repo. where running a full agent every few minutes would be wasteful. ${SCRIPT_CONTRACT} \`deliver\` decides where a returned value goes: a conversation you answer in, a project where you get a coder chat and a worktree of your own, or nothing because the script itself told the user. It ticks from the moment you create it, and a tool that would ask you in a chat runs here unattended.`,
      parameters: Type.Object({
        name: Type.String({ description: "Watcher name (max 100 chars, unique per user)." }),
        script: Type.String({ description: `The script body. ${SCRIPT_CONTRACT}` }),
        cronExpression: Type.String({
          description:
            "When to tick, as a 5-field cron expression (minute hour day month weekday), e.g. '*/10 * * * *'. Cron granularity is one minute.",
        }),
        deliver: Type.Optional(
          Type.String({
            description:
              'Where a fire goes: "chat" (answer in a conversation, the default), "silent" (nothing is woken. the script tells the user itself, e.g. with `tools.telegram_send`), or "coder" (a coder chat in `projectId`, in a worktree of its own, for work like reviewing a pull request).',
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              'The conversation a "chat" fire is answered in. Defaults to this conversation, and a "coder" or "silent" watcher ignores it. A watcher that dispatches into a project, or is delivered by its script, has no chat of its own and outlives any chat.',
          }),
        ),
        projectId: Type.Optional(
          Type.String({
            description: 'The project a "coder" fire dispatches into. Required for "coder".',
          }),
        ),
        worktreeMode: Type.Optional(
          Type.String({
            description:
              'For "coder": "per-fire" (default) gives every fire a fresh worktree, so two runs never share a directory. "sticky" keeps one chat and worktree for a thread that runs across fires.',
          }),
        ),
        retentionMinutes: Type.Optional(
          Type.Number({
            description:
              'For "coder": minutes a finished per-fire chat is kept before it is removed. Only a chat whose branch is pushed and whose tree is clean is ever removed. Default 1440.',
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
            description:
              "Model for the chat a \"coder\" fire opens (format 'provider:modelId'). Omit to use the user's default model.",
          }),
        ),
      }),
      outputSchema: watcherCreateSchema,
      execute: async (_toolCallId, params) => {
        try {
          const created = await createWatcher({
            userId,
            fields: {
              name: params.name,
              script: params.script,
              cronExpression: params.cronExpression,
              deliver: params.deliver,
              sessionId: params.sessionId ?? sessionId,
              projectId: params.projectId,
              worktreeMode: params.worktreeMode,
              retentionMinutes: params.retentionMinutes,
              wakePrompt: params.wakePrompt,
              description: params.description,
              cooldownMinutes: params.cooldownMinutes,
              modelId: params.modelId,
            },
          });

          return {
            value: {
              created: true,
              id: created.id,
              name: created.name,
              note: deliveryNote(created.deliver),
            },
          };
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }
      },
    }),

    // ─── watcher_update ─────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_update",
      label: "Update Watcher",
      description:
        "Update a watcher's script, cadence, delivery target, wake instructions, cooldown or enabled state. Read it with watcher_get first: only the fields you pass change, and the rest keep their stored value. A new script runs from the next tick on.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
        script: Type.Optional(Type.String({ description: "New script body." })),
        cronExpression: Type.Optional(Type.String({ description: "New cron expression." })),
        name: Type.Optional(Type.String({ description: "New name." })),
        description: Type.Optional(Type.String({ description: "New description." })),
        deliver: Type.Optional(
          Type.String({ description: 'New delivery: "chat", "silent" or "coder".' }),
        ),
        sessionId: Type.Optional(Type.String({ description: "New target conversation id." })),
        projectId: Type.Optional(
          Type.String({ description: 'New project for a "coder" watcher.' }),
        ),
        worktreeMode: Type.Optional(
          Type.String({ description: 'New worktree mode: "per-fire" or "sticky".' }),
        ),
        retentionMinutes: Type.Optional(
          Type.Number({ description: "New retention window for finished per-fire chats." }),
        ),
        wakePrompt: Type.Optional(Type.String({ description: "New wake instructions." })),
        cooldownMinutes: Type.Optional(Type.Number({ description: "New cooldown in minutes." })),
        modelId: Type.Optional(
          Type.String({
            description:
              'New model for the chat a "coder" fire opens. Null clears it, so the chat uses the default model.',
          }),
        ),
        enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the watcher." })),
      }),
      outputSchema: watcherUpdateSchema,
      execute: async (_toolCallId, params) => {
        const fields: Record<string, unknown> = {};
        for (const key of [
          "script",
          "cronExpression",
          "name",
          "description",
          "deliver",
          "sessionId",
          "projectId",
          "worktreeMode",
          "retentionMinutes",
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
          const updated = await updateWatcher({ id: params.watcherId, userId, fields });

          return {
            value: {
              updated: true,
              id: updated.id,
              note: deliveryNote(updated.deliver),
            },
          };
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }
      },
    }),

    // ─── watcher_ticks ──────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_ticks",
      label: "Watcher Tick Log",
      description:
        "Read a watcher's recent ticks. what its script returned, what it printed, and any error. This is how to see why a watcher is not reporting: a predicate that never matches looks the same as nothing happening.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
        limit: Type.Optional(Type.Number({ description: "How many ticks to read (default 10)." })),
      }),
      outputSchema: watcherTicksSchema,
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

        return {
          value: {
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
              tools: tick.toolNames,
              chatId: tick.sessionId,
            })),
          },
        };
      },
    }),

    // ─── watcher_delete ─────────────────────────────────────────────────────
    defineStructuredTool({
      name: "watcher_delete",
      label: "Delete Watcher",
      description: "Delete a script watcher and stop its ticks.",
      parameters: Type.Object({
        watcherId: Type.String({ description: "Watcher id." }),
      }),
      outputSchema: watcherDeleteSchema,
      execute: async (_toolCallId, params) => {
        try {
          await deleteWatcher(params.watcherId, userId);
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }

        return { value: { deleted: true, id: params.watcherId } };
      },
    }),
  ];
}
