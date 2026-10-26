import * as React from "react";

/** Input types that raise the on-screen keyboard. */
const KEYBOARD_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "password",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el instanceof HTMLInputElement && KEYBOARD_INPUT_TYPES.has(el.type);
}

/** True while a text field has focus, i.e. while the phone keyboard is up. */
export function useTextFieldFocus(): boolean {
  const [active, setActive] = React.useState(false);

  React.useEffect(() => {
    const update = () => setActive(isTextField(document.activeElement));
    // focusout reports before the browser moves activeElement; read it next tick
    const updateSoon = () => window.setTimeout(update, 0);

    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", updateSoon);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", updateSoon);
    };
  }, []);

  return active;
}
