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
import { previewScript, previewWatcherTick, runWatcherTick } from "@/lib/watchers/tick";

/**
 * Automation tools.
 *
 * An automation is a durable, unattended capability: a schedule, an optional
 * script that decides whether anything happened, and somewhere for a fire to go.
 * It can call the user's tools without anyone watching. Testing runs a script in
 * a sandbox without recording or waking anyone, and deleting only stops a tick
 * the user can recreate.
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

/** What a fire does, in the words the model needs to choose one. */
const DELIVER_CONTRACT =
  'A fire goes: "chat" (answered in a conversation), "none" (you run on your own with no chat, and the tools you call are the only way anything reaches the user), "silent" (nobody is woken. the script tells the user itself, e.g. with `tools.telegram_send`), or "coder" (a coder chat in `projectId`, in a worktree of its own, for work like reviewing a pull request).';

/** One automation as the list reports it. */
const automationSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** Null when it has no schedule and only runs by hand. */
  cron: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  /** "chat" | "none" | "silent" | "coder". */
  deliver: Type.String(),
  reportsTo: Type.Union([
    Type.Object({ chatId: Type.String(), title: Type.Union([Type.String(), Type.Null()]) }),
    Type.String(),
  ]),
  /** Null when it has no gate and fires on every tick. */
  gated: Type.Boolean(),
  maxFires: Type.Union([Type.Integer(), Type.Null()]),
  cooldownMinutes: Type.Union([Type.Integer(), Type.Null()]),
  ticks: Type.Integer(),
  fires: Type.Integer(),
  lastTickAt: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
});

const automationListSchema = Type.Object({
  count: Type.Integer(),
  automations: Type.Array(automationSchema),
});

/** One automation in full: every field `automation_update` writes, plus its counters. */
const automationDetailSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  script: Type.Union([Type.String(), Type.Null()]),
  cronExpression: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  /** "chat" | "none" | "silent" | "coder". */
  deliver: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  sessionTitle: Type.Union([Type.String(), Type.Null()]),
  projectId: Type.Union([Type.String(), Type.Null()]),
  projectName: Type.Union([Type.String(), Type.Null()]),
  worktreeMode: Type.String(),
  retentionMinutes: Type.Integer(),
  wakePrompt: Type.String(),
  modelId: Type.Union([Type.String(), Type.Null()]),
  thinkingLevel: Type.String(),
  cooldownMinutes: Type.Integer(),
  maxFires: Type.Union([Type.Integer(), Type.Null()]),
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
  /** The tools it called, which is how a silent automation delivered. */
  tools: Type.Array(Type.String()),
  /** What the woken agent answered, when there was no chat to answer in. */
  answer: Type.Optional(Type.String()),
});

const automationTestSchema = Type.Object(runOutcomeSchema.properties);

const automationCreateSchema = Type.Object({
  created: Type.Boolean(),
  id: Type.String(),
  name: Type.String(),
  note: Type.String(),
});

const automationUpdateSchema = Type.Object({
  updated: Type.Boolean(),
  id: Type.String(),
  note: Type.String(),
});

const automationTicksSchema = Type.Object({
  automation: Type.String(),
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
      answer: Type.Union([Type.String(), Type.Null()]),
      durationMs: Type.Number(),
      toolCalls: Type.Integer(),
      tools: Type.Array(Type.String()),
      /** The chat the fire was delivered into, when one was. */
      chatId: Type.Union([Type.String(), Type.Null()]),
      inputTokens: Type.Integer(),
      outputTokens: Type.Integer(),
    }),
  ),
});

const automationDeleteSchema = Type.Object({ deleted: Type.Boolean(), id: Type.String() });

/** A tick log entry, trimmed to what the model needs. */
function tickView(outcome: {
  status: string;
  value?: unknown;
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
  callNames: string[];
  answer?: string | null;
}): Static<typeof runOutcomeSchema> {
  return {
    status: outcome.status,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    output: outcome.output,
    durationMs: outcome.durationMs,
    toolCalls: outcome.callCount,
    tools: outcome.callNames,
    ...(outcome.answer ? { answer: outcome.answer } : {}),
  };
}

/** Where a fire goes, said plainly, for the list row. */
function reportsToView(
  serialized: ReturnType<typeof serializeWatcher>,
): string | { chatId: string; title: string | null } {
  if (serialized.deliver === "coder") {
    return `project ${serialized.projectName ?? serialized.projectId}`;
  }
  if (serialized.deliver === "none") return "nowhere (you run on your own and use your tools)";
  if (serialized.deliver === "silent") return "nothing (the script delivers it)";
  return serialized.sessionId
    ? { chatId: serialized.sessionId, title: serialized.sessionTitle }
    : "nothing";
}

export function createAutomationTools(userId: string, sessionId: string): ToolDefinition[] {
  return [
    // ─── automation_list ────────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_list",
      label: "List Automations",
      description:
        "List automations: the scheduled work that wakes you when its condition matches. Shows cadence, delivery target, fire limit and last outcome. Read one in full, script included, with automation_get.",
      parameters: Type.Object({}),
      outputSchema: automationListSchema,
      execute: async () => {
        const automations = await prisma.scriptWatcher.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          include: { session: { select: { title: true } }, project: { select: { name: true } } },
        });

        return {
          value: {
            count: automations.length,
            automations: automations.map((automation) => {
              const serialized = serializeWatcher(automation);
              return {
                id: serialized.id,
                name: serialized.name,
                cron: serialized.cronExpression,
                enabled: serialized.enabled,
                deliver: serialized.deliver,
                reportsTo: reportsToView(serialized),
                gated: serialized.script !== null,
                maxFires: serialized.maxFires,
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

    // ─── automation_get ─────────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_get",
      label: "Read Automation",
      description:
        "Read one automation in full: the script it runs (if any), its schedule, delivery target, wake instructions, worktree mode, cooldown, fire limit and model, plus what its last tick did. Everything automation_update can change is here, so read an automation you did not create before editing it.",
      parameters: Type.Object({
        automationId: Type.String({ description: "Automation id." }),
      }),
      outputSchema: automationDetailSchema,
      execute: async (_toolCallId, params) => {
        const automation = await prisma.scriptWatcher.findFirst({
          where: { id: params.automationId, userId },
          include: { session: { select: { title: true } }, project: { select: { name: true } } },
        });
        if (!automation) throw new Error(`Automation not found: ${params.automationId}`);

        const serialized = serializeWatcher(automation);

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
            thinkingLevel: serialized.thinkingLevel,
            cooldownMinutes: serialized.cooldownMinutes,
            maxFires: serialized.maxFires,
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

    // ─── automation_test ────────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_test",
      label: "Test Automation Script",
      description: `Run an automation script once and report what it returned, without scheduling it, recording a tick, or waking anyone. Use this to write and check a script before creating the automation. ${SCRIPT_CONTRACT} Provide either \`script\` (draft, at any point), or \`automationId\` to check a saved automation.`,
      parameters: Type.Object({
        script: Type.Optional(
          Type.String({
            description: "A draft script to run. May be provided before the automation exists.",
          }),
        ),
        automationId: Type.Optional(
          Type.String({
            description: "Run a saved automation's script instead.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "The conversation the script will report into. scopes chat-aware tools. Defaults to this conversation.",
          }),
        ),
      }),
      outputSchema: automationTestSchema,
      execute: async (_toolCallId, params) => {
        if (params.script && params.automationId) {
          throw new Error("Provide either `script` or `automationId`, not both.");
        }

        if (params.automationId) {
          const automation = await prisma.scriptWatcher.findFirst({
            where: { id: params.automationId, userId },
            select: { id: true },
          });
          if (!automation) throw new Error(`Automation not found: ${params.automationId}`);

          const outcome = await previewWatcherTick(params.automationId);
          return { value: tickView(outcome) };
        }

        if (!params.script?.trim()) {
          throw new Error("Provide `script` to run, or `automationId` to check a saved one.");
        }

        const outcome = await previewScript({
          userId,
          script: params.script,
          sessionId: params.sessionId ?? sessionId,
        });

        return { value: tickView(outcome) };
      },
    }),

    // ─── automation_create ──────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_create",
      label: "Create Automation",
      description: `Create an automation: it ticks on a cron schedule and does something with the tick. Use it for anything that has to happen later or on a cadence. checking a mailbox, a remote host, a feed, a git repo. where running a full agent every few minutes would be wasteful. Without a \`script\` there is no gate: every tick wakes you, which is what a plain scheduled prompt is. ${SCRIPT_CONTRACT} ${DELIVER_CONTRACT} It ticks from the moment you create it, and a tool that would ask you in a chat runs here unattended.`,
      parameters: Type.Object({
        name: Type.String({ description: "Automation name (max 100 chars, unique per user)." }),
        cronExpression: Type.Optional(
          Type.String({
            description:
              "When to tick, as a 5-field cron expression (minute hour day month weekday), e.g. '*/10 * * * *'. Cron granularity is one minute. Omit for an automation that only runs when started by hand. For something at a single time, name the minute, hour and date and set `maxFires: 1`.",
          }),
        ),
        script: Type.Optional(
          Type.String({
            description: `The script body. ${SCRIPT_CONTRACT} Omit it for work that should run on every tick.`,
          }),
        ),
        deliver: Type.Optional(Type.String({ description: DELIVER_CONTRACT })),
        sessionId: Type.Optional(
          Type.String({
            description:
              'The conversation a "chat" fire is answered in. Defaults to this conversation. Every other delivery answers nowhere but keeps this chat as the one its tools act as.',
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
              "Instructions for the agent when the automation fires. The script's returned value is appended automatically.",
          }),
        ),
        description: Type.Optional(Type.String({ description: "What this automation is for." })),
        cooldownMinutes: Type.Optional(
          Type.Number({
            description:
              "Minimum minutes between wakes. Use it to bound how often the automation can spend tokens.",
          }),
        ),
        maxFires: Type.Optional(
          Type.Number({
            description:
              "How many fires to deliver before the automation switches itself off. Use 1 for a one-off. Raise or clear it to start a finished automation again.",
          }),
        ),
        modelId: Type.Optional(
          Type.String({
            description:
              'Model for a fire that runs on its own ("none" or "coder", format \'provider:modelId\'). Omit to use the user\'s default.',
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.String({
            description:
              'Thinking level for a fire that runs on its own: "default", "off", "minimal", "low", "medium", "high", "xhigh" or "max".',
          }),
        ),
      }),
      outputSchema: automationCreateSchema,
      execute: async (_toolCallId, params) => {
        try {
          const created = await createWatcher({
            userId,
            originSessionId: sessionId,
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
              maxFires: params.maxFires,
              modelId: params.modelId,
              thinkingLevel: params.thinkingLevel,
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

    // ─── automation_update ──────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_update",
      label: "Update Automation",
      description:
        "Update an automation's script, schedule, delivery target, wake instructions, cooldown, fire limit or enabled state. Read it with automation_get first: only the fields you pass change, and the rest keep their stored value. A new script runs from the next tick on, and raising or clearing `maxFires` starts a finished automation again.",
      parameters: Type.Object({
        automationId: Type.String({ description: "Automation id." }),
        script: Type.Optional(
          Type.String({ description: "New script body. Pass an empty string to remove the gate." }),
        ),
        cronExpression: Type.Optional(
          Type.String({
            description: "New cron expression. Pass an empty string for no schedule.",
          }),
        ),
        name: Type.Optional(Type.String({ description: "New name." })),
        description: Type.Optional(Type.String({ description: "New description." })),
        deliver: Type.Optional(
          Type.String({ description: 'New delivery: "chat", "none", "silent" or "coder".' }),
        ),
        sessionId: Type.Optional(Type.String({ description: "New target conversation id." })),
        projectId: Type.Optional(
          Type.String({ description: 'New project for a "coder" automation.' }),
        ),
        worktreeMode: Type.Optional(
          Type.String({ description: 'New worktree mode: "per-fire" or "sticky".' }),
        ),
        retentionMinutes: Type.Optional(
          Type.Number({ description: "New retention window for finished per-fire chats." }),
        ),
        wakePrompt: Type.Optional(Type.String({ description: "New wake instructions." })),
        cooldownMinutes: Type.Optional(Type.Number({ description: "New cooldown in minutes." })),
        maxFires: Type.Optional(
          Type.Number({ description: "New fire limit. 0 or null removes the limit." }),
        ),
        modelId: Type.Optional(
          Type.String({
            description:
              "New model for a fire that runs on its own. Null clears it, so the user default applies.",
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.String({ description: "New thinking level for a standalone fire." }),
        ),
        enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the automation." })),
      }),
      outputSchema: automationUpdateSchema,
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
          "maxFires",
          "modelId",
          "thinkingLevel",
          "enabled",
        ]) {
          if (params[key as keyof typeof params] !== undefined) {
            fields[key] = params[key as keyof typeof params];
          }
        }

        // A limit of 0 reads as "no limit" rather than a rejection: the model
        // reaches for it to clear one.
        if (fields.maxFires === 0) fields.maxFires = null;

        if (Object.keys(fields).length === 0) {
          throw new Error("Provide at least one field to update.");
        }

        try {
          const updated = await updateWatcher({ id: params.automationId, userId, fields });

          return {
            value: {
              updated: true,
              id: updated.id,
              note: deliveryNote(updated.deliver as never),
            },
          };
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }
      },
    }),

    // ─── automation_run ─────────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_run",
      label: "Run Automation",
      description:
        "Run an automation once, right now, exactly as its schedule would: its script runs, and a fire is delivered. This spends what a real tick spends, so use it when the user asks for something to happen now.",
      parameters: Type.Object({
        automationId: Type.String({ description: "Automation id." }),
      }),
      outputSchema: automationTestSchema,
      execute: async (_toolCallId, params) => {
        const automation = await prisma.scriptWatcher.findFirst({
          where: { id: params.automationId, userId },
          select: { id: true },
        });
        if (!automation) throw new Error(`Automation not found: ${params.automationId}`);

        return { value: tickView(await runWatcherTick(params.automationId)) };
      },
    }),

    // ─── automation_ticks ───────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_ticks",
      label: "Automation Tick Log",
      description:
        "Read an automation's recent ticks. what it returned, what it printed, what the agent answered, and any error. This is how to see why an automation is not reporting: a script that never matches looks the same as nothing happening.",
      parameters: Type.Object({
        automationId: Type.String({ description: "Automation id." }),
        limit: Type.Optional(Type.Number({ description: "How many ticks to read (default 10)." })),
      }),
      outputSchema: automationTicksSchema,
      execute: async (_toolCallId, params) => {
        const automation = await prisma.scriptWatcher.findFirst({
          where: { id: params.automationId, userId },
          select: { id: true, name: true, enabled: true, lastError: true },
        });
        if (!automation) throw new Error(`Automation not found: ${params.automationId}`);

        const ticks = await prisma.scriptWatcherTick.findMany({
          where: { watcherId: params.automationId },
          orderBy: { createdAt: "desc" },
          take: Math.min(Math.max(params.limit ?? 10, 1), 50),
        });

        return {
          value: {
            automation: automation.name,
            enabled: automation.enabled,
            lastError: automation.lastError,
            ticks: ticks.map((tick) => ({
              at: tick.createdAt.toISOString(),
              status: tick.status,
              value: tick.value,
              error: tick.error,
              output: tick.output,
              answer: tick.answer,
              durationMs: tick.durationMs,
              toolCalls: tick.callCount,
              tools: tick.toolNames,
              chatId: tick.sessionId,
              inputTokens: tick.inputTokens,
              outputTokens: tick.outputTokens,
            })),
          },
        };
      },
    }),

    // ─── automation_delete ──────────────────────────────────────────────────
    defineStructuredTool({
      name: "automation_delete",
      label: "Delete Automation",
      description: "Delete an automation and stop its ticks.",
      parameters: Type.Object({
        automationId: Type.String({ description: "Automation id." }),
      }),
      outputSchema: automationDeleteSchema,
      execute: async (_toolCallId, params) => {
        try {
          await deleteWatcher(params.automationId, userId);
        } catch (err) {
          if (err instanceof WatcherInputError) throw new Error(err.message);
          throw err;
        }

        return { value: { deleted: true, id: params.automationId } };
      },
    }),
  ];
}
