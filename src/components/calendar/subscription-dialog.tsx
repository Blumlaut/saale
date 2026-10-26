"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Loader2, Link as LinkIcon, Trash2 } from "lucide-react";
import { postJson, patchJson, deleteJson } from "@/lib/http";
import type { CalendarAccountSummary } from "@/types/shared";

interface SubscriptionData {
  id: string;
  name: string;
  url: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
}

interface SubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccountSummary[];
  subscription?: SubscriptionData | null;
  onSuccess?: () => void;
}

export function SubscriptionDialog({
  open,
  onOpenChange,
  accounts,
  subscription,
  onSuccess,
}: SubscriptionDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const isEditing = !!subscription;

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

    if (subscription) {
      setName(subscription.name);
      setUrl(subscription.url);
      setCalendarId(subscription.calendarId);
      setUsername("");
      setPassword("");
    } else {
      const firstCalendar = localCalendars[0];
      if (firstCalendar) {
        setCalendarId(firstCalendar.id);
      }
    }
    setError("");
  }, [open, subscription, resetForm, localCalendars]);

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      if (isEditing && subscription) {
        await patchJson(`/api/calendar/subscriptions/${subscription.id}`, {
          name,
          url,
          username: username || null,
          password: password || null,
        });
      } else {
        await postJson("/api/calendar/subscriptions", {
          name,
          url,
          calendarId,
          username: username || null,
          password: password || null,
        });
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!subscription) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/calendar/subscriptions/${subscription.id}`);
      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit ICS Subscription" : "Add ICS Subscription"}</DialogTitle>
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
            {isEditing ? (
              <div className="text-muted-foreground rounded-lg border px-3 py-2 text-sm">
                {localCalendars.find((c) => c.id === calendarId)?.name || calendarId}
                <span className="text-muted-foreground/60 ml-2">(cannot be changed)</span>
              </div>
            ) : localCalendars.length === 0 ? (
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <div className="flex items-center justify-between">
            {isEditing ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                className="text-destructive hover:text-destructive"
              >
                {deleting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Remove
              </Button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving || !name || !url || !calendarId}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : isEditing ? (
                  "Save Changes"
                ) : (
                  "Add Subscription"
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
