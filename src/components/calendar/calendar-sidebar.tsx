"use client";

import { useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
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
import { patchJson, deleteJson, postJson } from "@/lib/http";

interface CalendarAccount {
  id: string;
  name: string;
  accountType: string;
  enabled: boolean;
  calendars: Array<{
    id: string;
    name: string;
    color: string | null;
    enabled: boolean;
    eventCount: number;
  }>;
}

interface CalendarSidebarProps {
  accounts: CalendarAccount[];
  onAccountsChange: () => Promise<void>;
}

export function CalendarSidebar({ accounts, onAccountsChange }: CalendarSidebarProps) {
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [newCalendarName, setNewCalendarName] = useState("");
  const [newCalendarColor, setNewCalendarColor] = useState("#3b82f6");
  const [addingForAccountId, setAddingForAccountId] = useState<string | null>(null);
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState("");

  const totalEvents = accounts.reduce(
    (sum, acc) => sum + acc.calendars.reduce((c, cal) => c + cal.eventCount, 0),
    0,
  );

  const handleToggleCalendar = useCallback(
    async (calendarId: string, enabled: boolean) => {
      try {
        await patchJson(`/api/calendar/calendars/${calendarId}`, { enabled });
        await onAccountsChange();
      } catch {
        // Ignore
      }
    },
    [onAccountsChange],
  );

  const handleDeleteCalendar = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteJson(`/api/calendar/calendars/${pendingDelete}`);
      await onAccountsChange();
    } catch {
      // Ignore
    } finally {
      setAlertOpen(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, onAccountsChange]);

  const handleAddCalendar = useCallback(
    async (accountId: string) => {
      if (!newCalendarName.trim()) return;
      try {
        await postJson("/api/calendar/calendars", {
          name: newCalendarName.trim(),
          color: newCalendarColor,
          accountId,
        });
        setNewCalendarName("");
        setAddingForAccountId(null);
        await onAccountsChange();
      } catch {
        // Ignore
      }
    },
    [newCalendarName, newCalendarColor, onAccountsChange],
  );

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
      } catch {
        // Ignore
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

  return (
    <div className="w-52 shrink-0 space-y-4">
      {/* Summary */}
      <GlassPanel>
        <GlassPanelContent className="space-y-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="text-muted-foreground h-4 w-4" />
            <span className="text-sm font-medium">
              {accounts.length} account{accounts.length !== 1 ? "s" : ""}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">{totalEvents} total events</p>
        </GlassPanelContent>
      </GlassPanel>

      {/* Calendars */}
      <GlassPanel>
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
                      onClick={() => setAddingForAccountId(account.id)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                {/* Add calendar form */}
                {addingForAccountId === account.id && (
                  <div className="border-border/50 mt-2 space-y-1.5 rounded-lg border p-2">
                    <input
                      autoFocus
                      className="border-border/50 focus:border-ring w-full rounded bg-transparent px-1.5 py-1 text-xs outline-none"
                      placeholder="Calendar name"
                      value={newCalendarName}
                      onChange={(e) => setNewCalendarName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddCalendar(account.id);
                        if (e.key === "Escape") setAddingForAccountId(null);
                      }}
                    />
                    <div className="flex items-center gap-1">
                      {defaultColors.map((color) => (
                        <button
                          key={color}
                          onClick={() => setNewCalendarColor(color)}
                          className={`h-3.5 w-3.5 shrink-0 rounded-full transition-all ${
                            newCalendarColor === color
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
                        onClick={() => handleAddCalendar(account.id)}
                        disabled={!newCalendarName.trim()}
                      >
                        Add
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-2 text-[10px]"
                        onClick={() => {
                          setAddingForAccountId(null);
                          setNewCalendarName("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

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
