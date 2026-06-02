"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle, Loader2, Calendar } from "lucide-react";
import { postJson } from "@/lib/http";

interface CalendarAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CalendarAccountDialog({
  open,
  onOpenChange,
  onSuccess,
}: CalendarAccountDialogProps) {
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    calendars?: Array<{ url: string; displayName: string; calendarColor?: string }>;
  } | null>(null);
  const [error, setError] = useState("");

  const resetForm = useCallback(() => {
    setName("");
    setServerUrl("");
    setUsername("");
    setPassword("");
    setTestResult(null);
    setError("");
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError("");

    try {
      const data = await postJson<{
        success: boolean;
        error?: string;
        calendars?: Array<{ url: string; displayName: string; calendarColor?: string }>;
      }>("/api/calendar/accounts/new/test-connection", {
        name,
        serverUrl,
        username,
        password,
      });
      setTestResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      await postJson("/api/calendar/accounts", {
        name,
        serverUrl,
        username,
        password,
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
          <DialogTitle>Add Calendar Account</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Account details */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Account Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Calendar"
              />
            </div>
            <div className="space-y-2">
              <Label>CalDAV URL</Label>
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://caldav.example.com/calendars/user"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Password / App Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              {testResult.success ? (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-green-600 dark:text-green-400">Connected</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <AlertCircle className="text-destructive h-4 w-4" />
                  <span className="text-destructive">{testResult.error}</span>
                </div>
              )}
              {testResult.calendars && testResult.calendars.length > 0 && (
                <div className="mt-1 flex flex-col gap-1">
                  <p className="text-muted-foreground text-xs">
                    Found {testResult.calendars.length} calendar(s):
                  </p>
                  {testResult.calendars.map((cal) => (
                    <div key={cal.url} className="flex items-center gap-2 text-xs">
                      {cal.calendarColor ? (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: cal.calendarColor }}
                        />
                      ) : (
                        <Calendar className="text-muted-foreground h-3 w-3" />
                      )}
                      <span>{cal.displayName || cal.url}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !serverUrl || !password}
            >
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button onClick={handleSave} disabled={saving || !name || !serverUrl || !password}>
              {saving ? "Saving..." : "Save Account"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
