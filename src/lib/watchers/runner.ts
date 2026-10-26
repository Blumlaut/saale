/**
 * Running one watcher tick: the script in the codemode sandbox, with no model
 * involved.
 *
 * The sandbox is the same one `codemode` uses in a chat (`CodemodeSandbox`
 * QuickJS in a worker thread, no timers, no `fetch`, no `require`), so a script
 * written in a conversation runs here unchanged: it sees `tools.<name>(args)`,
 * `text()`, `console.*`, `store()`/`load()`, the discovery helpers
 * `searchTools()`/`describeTool()`/`describeNamespace()` (which a chat's sandbox
 * gets from Pi's extension, and this one from `codemode-discovery.ts`), and
 * returns a value.
 *
 * Two differences from the chat path, both because there is nobody watching:
 *
 * - The tool table is built directly instead of through Pi's agent loop. A call
 *   that would ask the user in a chat runs here on the script's say-so, so a
 *   tick does not stop to wait for an answer nobody can give.
 * - The script's deadline is a tick budget. In a chat the model waits out a slow
 *   script; here a tick that overruns would pile up against the next one.
 */

import {
  CodemodeSandbox,
  type CodemodeJsonSchema,
  type CodemodeOutputItem,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDiscoveryGlobals, toolSample } from "@/lib/pi/codemode-discovery";

/** How long one tick's script may run. */
const TICK_TIMEOUT_MS = Number(process.env.WATCHER_TICK_TIMEOUT_MS ?? 60_000);

/** Memory ceiling for the sandbox VM. */
const TICK_MEMORY_LIMIT_BYTES = Number(process.env.WATCHER_TICK_MEMORY_BYTES ?? 128 * 1024 * 1024);

/** Result of one tick's script. */
export interface WatcherScriptResult {
  /** False when the script threw, failed to parse, timed out or was aborted. */
  ok: boolean;
  /** The script's `return` value. `undefined` means it declined the `return`. */
  value: unknown;
  /** `text()` and `console.*` output, joined. the tick log's readable part. */
  output: string;
  /** How many tool calls the script made. */
  callCount: number;
  /** Which tools it called, in the order it first reached them. */
  callNames: string[];
  durationMs: number;
  /** The script's `store()` writes, to carry into the next tick. */
  storeWrites: { set: Record<string, unknown>; delete: string[] };
  /** Present only when `ok` is false. */
  error?: string;
}

/** The text of a tool result, which is what a script receives. */
function resultText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Turn Saale's tools into sandbox tools.
 *
 * The set is already decided. `watcherToolAccess` is the one place that answers
 * what a script may reach. so nothing is filtered here.
 *
 * A call resolves exactly the way Pi's own codemode bridge resolves it
 * (`toScriptValue` in the codemode extension): a tool that declares an
 * `outputSchema` hands back its `structuredContent`, also when the call failed
 * and carried one; any other tool hands back its text. Anything else that fails
 * rejects, so the script sees an `Error` and can catch it.
 *
 * The rule matters more here than in a chat: the text carries UI metadata and an
 * echo of the call's own arguments, so a script that had only the text would
 * match a marker against its own query. which is how a watcher fires early.
 *
 * `ctx` is left undefined. No tool dereferences it. the two that accept it
 * merely forward it to Pi's built-in read/edit, which read `ctx?.cwd` and
 * `ctx?.model` through optional chaining and fall back to their own defaults.
 */
function toSandboxTools(
  tools: readonly ToolDefinition[],
  samples: ReadonlyMap<string, string>,
): CodemodeTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    // The rendered sample, as in a chat: the description a script reads back from
    // `ALL_TOOLS` and `searchTools()` is the one it would see there.
    description: samples.get(tool.name) ?? tool.description,
    // Rendered into the script's declarations ("ALL_TOOLS") only; the sandbox
    // does not validate calls against it, so TypeBox's schema is passed
    // through as the JSON Schema document it already is.
    inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
    execute: async (args: unknown, { signal }: { signal: AbortSignal }) => {
      // Deliberately undefined: a watcher tick has no agent loop behind it.
      const noContext = undefined as unknown as ExtensionToolContext;
      const result = await tool.execute(`watcher/${tool.name}`, args, signal, undefined, noContext);

      // Pi gates the value on the declaration, not on the field being set, so a
      // tool that never declared an `outputSchema` cannot quietly start handing
      // scripts an object they were never told about.
      if (tool.outputSchema && result.structuredContent !== undefined) {
        return result.structuredContent;
      }

      const text = resultText(result.content);
      if (result.isError) {
        throw new Error(text || `Tool "${tool.name}" failed`);
      }
      return text;
    },
  }));
}

/** Join the sandbox's output items into one string, images marked in place. */
function formatOutput(output: readonly CodemodeOutputItem[]): string {
  return output
    .map((item) => (item.type === "text" ? item.text : `[image: ${item.mimeType}]`))
    .join("\n");
}

/**
 * Run one watcher script.
 *
 * Never rejects: a script that throws, times out or is aborted comes back as
 * `ok: false` with the reason, because a failed tick is a normal tick that the
 * log has to show.
 */
export async function runWatcherScript(options: {
  script: string;
  tools: readonly ToolDefinition[];
  /** Values the script reads with `load()`. */
  store: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<WatcherScriptResult> {
  // Both are built from one set of samples, so `ALL_TOOLS`, the discovery
  // helpers and the tool table describe a tool with the same text.
  const samples = new Map(options.tools.map((tool) => [tool.name, toolSample(tool)]));

  const sandbox = new CodemodeSandbox({
    tools: toSandboxTools(options.tools, samples),
    globals: createDiscoveryGlobals(options.tools, samples),
    timeoutMs: TICK_TIMEOUT_MS,
    memoryLimitBytes: TICK_MEMORY_LIMIT_BYTES,
  });

  const startedAt = Date.now();
  const toolNames = new Set(options.tools.map((tool) => tool.name));
  try {
    const result = await sandbox.execute(options.script, {
      store: options.store,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const durationMs = Date.now() - startedAt;
    const callCount = result.calls.length;
    // Globals (`text`, `console`) are calls too, and saying a tick ran
    // `console` has never helped anyone read it.
    const callNames = [...new Set(result.calls.map((call) => call.name))].filter((name) =>
      toolNames.has(name),
    );

    if (!result.ok) {
      return {
        ok: false,
        value: undefined,
        output: formatOutput(result.output),
        callCount,
        callNames,
        durationMs,
        storeWrites: { set: {}, delete: [] },
        error: `${result.error.kind}: ${result.error.message}`,
      };
    }

    return {
      ok: true,
      value: result.value,
      output: formatOutput(result.output),
      callCount,
      callNames,
      durationMs,
      storeWrites: result.storeWrites,
    };
  } catch (err) {
    // The sandbox rejects only for a failure outside the script's control
    // a missing worker or wasm file. That is worth surfacing as a real error.
    console.error("Watcher sandbox failed to start:", err);
    return {
      ok: false,
      value: undefined,
      output: "",
      callCount: 0,
      callNames: [],
      durationMs: Date.now() - startedAt,
      storeWrites: { set: {}, delete: [] },
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await sandbox.close();
  }
}

/**
 * Whether a script's return value is a report worth waking the agent for.
 *
 * `undefined`, `null` and `false` mean "nothing changed". the common case, and
 * the whole reason a tick is cheap. Anything else is handed to the agent, so a
 * script reports by returning something.
 */
export function isFiring(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** Apply the script's `store()` writes to the state the next tick reads. */
export function applyStoreWrites(
  store: Record<string, unknown>,
  writes: { set: Record<string, unknown>; delete: string[] },
): Record<string, unknown> {
  const next = { ...store };
  for (const key of writes.delete) delete next[key];
  return { ...next, ...writes.set };
}
