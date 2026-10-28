"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";
import { MENU_POPUP_CLASS } from "./dropdown-menu";

/**
 * The right-click menu.
 *
 * Root, trigger and popup only: its items are the dropdown menu's, because both
 * draw Base UI's `Menu.Item`. A menu that has to look the same whether it was
 * opened by a row's button or by a right click therefore defines its items once.
 */
function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            MENU_POPUP_CLASS,
            // A context menu is anchored to the pointer, so it has no trigger to
            // take a width from.
            "w-auto min-w-40",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent };
