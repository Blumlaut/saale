"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CommandPalette } from "@/components/layout/command-palette";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Show the box, from a button or a keyboard shortcut. */
  show: () => void;
  toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

/** The one ⌘K box the shell renders, wherever it is opened from. */
export function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within a CommandPaletteProvider");
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  const value = useMemo(() => ({ open, setOpen, show, toggle }), [open, show, toggle]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </CommandPaletteContext.Provider>
  );
}
