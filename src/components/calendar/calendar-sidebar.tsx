"use client";

import { useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarDays, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { patchJson, deleteJson, postJson } from "@/lib/http";
import type { CalendarAccountSummary } from "@/types/shared";

interface CalendarSidebarProps {
  accounts: CalendarAccountSummary[];
  onAccountsChange: () => Promise<void>;
}

export function CalendarSidebar({ accounts, onAccountsChange }: CalendarSidebarProps) {
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [addAccountId, setAddAccountId] = useState<string | null>(null);
  const [newCalendarName, setNewCalendarName] = useState("");
  const [newCalendarColor, setNewCalendarColor] = useState("#3b82f6");
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState("");

  const totalEvents = accounts.reduce(
    (sum, acc) => sum + acc.calendars.reduce((c, cal) => c + (cal.eventCount ?? 0), 0),
    0,
  );

  const handleToggleCalendar = useCallback(
    async (calendarId: string, enabled: boolean) => {
      try {
        await patchJson(`/api/calendar/calendars/${calendarId}`, { enabled });
        await onAccountsChange();
      } catch (err) {
        console.error("Failed to toggle calendar:", err);
      }
    },
    [onAccountsChange],
  );

  const handleDeleteCalendar = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteJson(`/api/calendar/calendars/${pendingDelete}`);
      await onAccountsChange();
    } catch (err) {
      console.error("Failed to delete calendar:", err);
    } finally {
      setAlertOpen(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, onAccountsChange]);

  const openAddSheet = (accountId: string) => {
    setAddAccountId(accountId);
    setNewCalendarName("");
    setNewCalendarColor("#3b82f6");
    setAddSheetOpen(true);
  };

  const closeAddSheet = () => {
    setAddSheetOpen(false);
    setAddAccountId(null);
    setNewCalendarName("");
  };

  const handleAddCalendar = useCallback(async () => {
    if (!newCalendarName.trim() || !addAccountId) return;
    try {
      await postJson("/api/calendar/calendars", {
        name: newCalendarName.trim(),
        color: newCalendarColor,
        accountId: addAccountId,
      });
      closeAddSheet();
      await onAccountsChange();
    } catch (err) {
      console.error("Failed to create calendar:", err);
    }
  }, [newCalendarName, newCalendarColor, addAccountId, onAccountsChange]);

  const handleEditCalendar = useCallback(
    async (calendarId: string) => {
      if (!editingName.trim()) return;
      try {
        await patchJson(`/api/calendar/calendars/${calendarId}`, {
          name: editingName.trim(),
          color: editingColor || undefined,
        });
        setEditingCalendarId(null);
        setEditingName("");
        await onAccountsChange();
      } catch (err) {
        console.error("Failed to save calendar:", err);
      }
    },
    [editingName, editingColor, onAccountsChange],
  );

  const defaultColors = [
    "#3b82f6",
    "#ef4444",
    "#22c55e",
    "#f59e0b",
    "#8b5cf6",
    "#ec4899",
    "#06b6d4",
    "#f97316",
  ];

  const totalAccounts = accounts.length;

  return (
    <div className="flex flex-row gap-4 md:w-52 md:shrink-0 md:flex-col">
      {/* Summary */}
      <GlassPanel className="flex-shrink-0">
        <GlassPanelContent className="flex items-center gap-3 py-3">
          <CalendarDays className="text-muted-foreground h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {totalAccounts} account{totalAccounts !== 1 ? "s" : ""}
            </p>
            <p className="text-muted-foreground truncate text-xs">{totalEvents} total events</p>
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Calendars */}
      <GlassPanel className="flex-1">
        <GlassPanelContent className="p-0">
          {accounts.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-muted-foreground text-xs">No accounts connected</p>
              <p className="text-muted-foreground/60 mt-1 text-[10px]">
                Add one in Settings → Calendar
              </p>
            </div>
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="truncate text-xs font-medium">{account.name}</span>
                  {account.accountType === "local" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      aria-label="Add calendar"
                      title="Add calendar"
                      onClick={() => openAddSheet(account.id)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                {account.calendars.map((cal) => (
                  <div key={cal.id} className="mt-1">
                    {/* Editing form */}
                    {editingCalendarId === cal.id ? (
                      <div className="border-border/50 flex flex-col gap-1.5 rounded-lg border p-2">
                        <input
                          autoFocus
                          className="border-border/50 focus:border-ring w-full rounded bg-transparent px-1.5 py-1 text-xs outline-none"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEditCalendar(cal.id);
                            if (e.key === "Escape") setEditingCalendarId(null);
                          }}
                        />
                        <div className="flex items-center gap-1">
                          {defaultColors.map((color) => (
                            <button
                              key={color}
                              onClick={() => setEditingColor(color)}
                              className={`h-3 w-3 shrink-0 rounded-full transition-all ${
                                editingColor === color
                                  ? "ring-ring scale-110 ring-2 ring-offset-1 ring-offset-transparent"
                                  : "opacity-60 hover:opacity-100"
                              }`}
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={() => handleEditCalendar(cal.id)}
                            disabled={!editingName.trim()}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={() => {
                              setEditingCalendarId(null);
                              setEditingName("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 pl-2">
                        <button
                          onClick={() => handleToggleCalendar(cal.id, !cal.enabled)}
                          className={`h-2 w-2 shrink-0 rounded-full transition-opacity ${
                            cal.enabled ? "" : "opacity-30"
                          }`}
                          style={{
                            backgroundColor: cal.color || "var(--muted-foreground)",
                          }}
                          title={cal.enabled ? "Hide calendar" : "Show calendar"}
                        />
                        <span className="text-muted-foreground truncate text-[11px]">
                          {cal.name}
                        </span>
                        <span className="text-muted-foreground/60 ml-auto text-[9px]">
                          {cal.eventCount}
                        </span>

                        {account.accountType === "local" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button variant="ghost" size="icon" className="h-4 w-4 p-0">
                                  <MoreVertical className="h-2.5 w-2.5" />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingCalendarId(cal.id);
                                  setEditingName(cal.name);
                                  setEditingColor(cal.color || "");
                                }}
                              >
                                <Pencil className="mr-2 h-3 w-3" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setPendingDelete(cal.id);
                                  setAlertOpen(true);
                                }}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="mr-2 h-3 w-3" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </GlassPanelContent>
      </GlassPanel>

      {/* Add Calendar Sheet */}
      <Sheet open={addSheetOpen} onOpenChange={setAddSheetOpen}>
        <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
          <div className="flex h-full flex-col">
            {/* Header */}
            <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
              <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
                New Calendar
              </SheetTitle>
            </SheetHeader>

            {/* Form */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="space-y-5">
                {/* Name */}
                <div className="space-y-2">
                  <Label className="text-xs">Name</Label>
                  <Input
                    autoFocus
                    className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
                    placeholder="Calendar name"
                    value={newCalendarName}
                    onChange={(e) => setNewCalendarName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddCalendar();
                    }}
                  />
                </div>

                {/* Color */}
                <div className="space-y-2">
                  <Label className="text-xs">Color</Label>
                  <div className="flex items-center gap-2">
                    {defaultColors.map((color) => (
                      <button
                        key={color}
                        onClick={() => setNewCalendarColor(color)}
                        className={`h-8 w-8 shrink-0 rounded-full transition-all ${
                          newCalendarColor === color
                            ? "ring-ring scale-110 ring-2 ring-offset-2 ring-offset-transparent"
                            : "opacity-60 hover:opacity-100"
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="border-border/30 border-t px-6 py-4">
              <div className="flex items-center gap-2">
                <Button
                  className="liquid-glass-pill h-9 flex-1 rounded-full text-xs font-medium"
                  onClick={closeAddSheet}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="liquid-glass-accent h-9 flex-1 rounded-full text-xs font-medium"
                  disabled={!newCalendarName.trim()}
                  onClick={handleAddCalendar}
                >
                  Add Calendar
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirmation */}
      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Calendar</AlertDialogTitle>
            <AlertDialogDescription>
              Delete this calendar and all its events? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCalendar} variant="destructive">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
