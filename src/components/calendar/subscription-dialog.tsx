"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Loader2, Link as LinkIcon } from "lucide-react";
import { postJson } from "@/lib/http";

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
  }>;
}

interface SubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccount[];
  onSuccess?: () => void;
}

export function SubscriptionDialog({
  open,
  onOpenChange,
  accounts,
  onSuccess,
}: SubscriptionDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const localAccount = accounts.find((a) => a.accountType === "local");
  const localCalendars = useMemo(
    () => localAccount?.calendars.filter((c) => c.enabled) ?? [],
    [localAccount],
  );

  const resetForm = useCallback(() => {
    setName("");
    setUrl("");
    setCalendarId("");
    setUsername("");
    setPassword("");
    setError("");
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }
    const firstCalendar = localCalendars[0];
    if (firstCalendar && !calendarId) {
      setCalendarId(firstCalendar.id);
    }
  }, [open, resetForm, localCalendars, calendarId]);

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      await postJson("/api/calendar/subscriptions", {
        name,
        url,
        calendarId,
        username: username || null,
        password: password || null,
      });

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add ICS Subscription</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Name */}
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Holidays, Team Calendar..."
            />
          </div>

          {/* URL */}
          <div className="space-y-2">
            <Label>
              <LinkIcon className="mr-1 inline h-3 w-3" />
              ICS URL
            </Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/calendar.ics"
            />
          </div>

          {/* Target calendar */}
          <div className="space-y-2">
            <Label>Target Calendar</Label>
            {localCalendars.length === 0 ? (
              <div className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
                No local calendars available. Create one first.
              </div>
            ) : (
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                className="border-input focus-visible:ring-ring flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
              >
                {localCalendars.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Auth (optional) */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>
                Username <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>
                Password <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !name || !url || !calendarId}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Add Subscription"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
