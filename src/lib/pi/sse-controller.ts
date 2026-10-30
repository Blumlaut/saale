/**
 * Shared helpers for the SSE stream controllers held by the heartbeat and the
 * session dispatcher.
 */

const CLOSED_CONTROLLER_ERROR_CODE = "ERR_INVALID_STATE";

/** True when an `enqueue` failure means the client's controller is already closed. */
export function isClosedControllerError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === CLOSED_CONTROLLER_ERROR_CODE
  );
}
