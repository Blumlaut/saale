import type { KeyboardEvent } from "react";

/** Where the primary pointer is a finger, the on-screen keyboard has no Shift key. */
const TOUCH_KEYBOARD_QUERY = "(pointer: coarse)";

/**
 * Enter submits. A touch keyboard has no Shift key, so there Enter stays a
 * newline and the send button does the submitting.
 */
export function isSendKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  // Confirming an IME candidate also arrives as Enter.
  if (event.nativeEvent.isComposing) return false;
  // Without matchMedia there is no way to tell, so a hardware keyboard is assumed.
  if (typeof window.matchMedia !== "function") return true;
  return !window.matchMedia(TOUCH_KEYBOARD_QUERY).matches;
}
