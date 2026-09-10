import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Make tool calls respect the run's abort signal.
 *
 * Pi awaits `tool.execute(...)` and hands it the run's `AbortSignal`, so a tool
 * that ignores the signal keeps the whole run alive: pressing Stop only takes
 * effect once the tool returns, which for a long terminal command or a slow
 * fetch looks like Stop doing nothing at all. The agent's loop can only check
 * the signal *between* tool calls.
 *
 * This races the tool against the signal so the call ends as soon as the run is
 * aborted. The tool itself keeps running in the background (its own cancellation,
 * if any — the terminal tools kill their command on the same signal — still
 * applies); what changes is that the run no longer waits for it.
 *
 * The rejection matches Pi's own wording for a cancelled tool call so the result
 * shown to the user and stored in the transcript is the same either way.
 */

/** Message Pi's loop uses when it cancels a tool call itself. */
export const TOOL_ABORT_MESSAGE = "Operation aborted";

function abortedError(): Error {
  const error = new Error(TOOL_ABORT_MESSAGE);
  // Pi and Node distinguish cancellations by name, not just message.
  error.name = "AbortError";
  return error;
}

/**
 * Wrap a tool so its execution ends when the abort signal fires.
 *
 * @param tool - The tool definition to wrap (left otherwise untouched).
 */
export function withAbortSignal(tool: ToolDefinition): ToolDefinition {
  const originalExecute = tool.execute;

  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) => {
      // No signal — nothing can be cancelled, so don't interfere.
      if (!signal) {
        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (signal.aborted) {
        return Promise.reject(abortedError());
      }

      return new Promise((resolve, reject) => {
        let aborted = false;

        const cleanup = () => signal.removeEventListener("abort", onAbort);
        function onAbort() {
          aborted = true;
          cleanup();
          reject(abortedError());
        }

        signal.addEventListener("abort", onAbort, { once: true });

        // Both outcomes are handled, so a tool that settles after the abort
        // cannot become an unhandled rejection.
        originalExecute(toolCallId, params, signal, onUpdate, ctx).then(
          (result) => {
            cleanup();
            resolve(result);
          },
          (error: unknown) => {
            cleanup();
            if (aborted) {
              console.error(`Tool "${tool.name}" failed after the run was aborted:`, error);
            }
            reject(error);
          },
        );
      });
    },
  };
}
