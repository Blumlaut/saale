"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, BellOff, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import {
  getNotificationPermission,
  getPushSubscription,
  isPushSupported,
  serializeSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push/client";
import {
  NOTIFICATION_CATEGORIES,
  readNotificationPreferences,
  type NotificationCategory,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import type { UserSettings } from "../types";

interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

/** Which state the notification switch has on this device. */
type DeviceState = "checking" | "unsupported" | "unconfigured" | "denied" | "off" | "on";

interface NotificationsTabProps {
  settings: UserSettings | null;
  /** Persist a partial change immediately. a toggle takes effect on the spot. */
  onPatch: (patch: Partial<UserSettings>) => Promise<void>;
  saving: boolean;
}

export function NotificationsTab({ settings, onPatch, saving }: NotificationsTabProps) {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [device, setDevice] = useState<DeviceState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const preferences = readNotificationPreferences(settings?.pushNotifications);

  const loadConfig = useCallback(async () => {
    try {
      const data = await fetchJson<PushConfig>("/api/push");
      setConfig(data);
      return data;
    } catch (err) {
      console.error("Failed to load push notification settings:", err);
      setError("Could not load the notification settings.");
      return null;
    }
  }, []);

  const loadDeviceState = useCallback(async (pushConfig: PushConfig | null) => {
    if (!isPushSupported()) {
      setDevice("unsupported");
      return;
    }
    if (!pushConfig?.enabled || !pushConfig.publicKey) {
      setDevice("unconfigured");
      return;
    }
    if (getNotificationPermission() === "denied") {
      setDevice("denied");
      return;
    }

    const subscription = await getPushSubscription().catch((err) => {
      console.error("Failed to read this browser's push subscription:", err);
      return null;
    });
    setDevice(subscription ? "on" : "off");
  }, []);

  useEffect(() => {
    void (async () => {
      const pushConfig = await loadConfig();
      await loadDeviceState(pushConfig);
    })();
  }, [loadConfig, loadDeviceState]);

  const enable = async () => {
    if (!config?.publicKey) return;

    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeToPush(config.publicKey);
      const payload = serializeSubscription(subscription);
      if (!payload) throw new Error("The browser returned an incomplete subscription.");

      await postJson("/api/push/subscribe", payload);
      setDevice("on");
    } catch (err) {
      console.error("Failed to enable push notifications:", err);
      setError(err instanceof Error ? err.message : "Could not enable notifications.");
      // A refused permission is a terminal state for this browser.
      if (getNotificationPermission() === "denied") setDevice("denied");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await deleteJson("/api/push/subscribe", { endpoint });
      setDevice("off");
    } catch (err) {
      console.error("Failed to turn off push notifications:", err);
      setError("Could not turn notifications off on this device.");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await postJson("/api/push/test", {});
      setSent(true);
    } catch (err) {
      console.error("Failed to send a test notification:", err);
      setError(err instanceof Error ? err.message : "Could not send a test notification.");
    } finally {
      setBusy(false);
    }
  };

  const setCategory = (category: NotificationCategory, enabled: boolean) => {
    const next: NotificationPreferences = { ...preferences, [category]: enabled };
    void onPatch({ pushNotifications: next });
  };

  return (
    <div className="space-y-6">
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Bell className="h-5 w-5" />
              Notifications
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Get a notification when something needs you, even when Saale is closed.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Label>This device</Label>
                <p className="text-muted-foreground mt-1 text-sm">
                  {device === "checking" && "Checking this browser…"}
                  {device === "unsupported" &&
                    "This browser cannot show notifications. On iPhone and iPad, add Saale to your home screen first."}
                  {device === "unconfigured" &&
                    "Notifications are not set up on this instance. An administrator has to add the VAPID keys."}
                  {device === "denied" &&
                    "Notifications are blocked for Saale in this browser. Allow them in the browser's site settings, then reload."}
                  {device === "off" && "Notifications are off on this device."}
                  {device === "on" && "Notifications are on for this device."}
                </p>
              </div>

              {device === "checking" ||
              device === "unsupported" ||
              device === "unconfigured" ? null : (
                <div className="flex shrink-0 items-center gap-2">
                  {device === "on" ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={sendTest} disabled={busy}>
                        {busy ? <Loader2 className="animate-spin" /> : <Send />}
                        Send test
                      </Button>
                      <Button variant="ghost" size="sm" onClick={disable} disabled={busy}>
                        <BellOff />
                        Turn off
                      </Button>
                    </>
                  ) : (
                    <Button onClick={enable} disabled={busy || device === "denied"}>
                      {busy ? <Loader2 className="animate-spin" /> : <Bell />}
                      Enable on this device
                    </Button>
                  )}
                </div>
              )}
            </div>

            {sent && (
              <p className="text-muted-foreground text-sm">
                Test sent. Nothing appeared? Check that the browser is allowed to show
                notifications.
              </p>
            )}

            {error && (
              <p className="text-destructive flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}

            <div className="space-y-4 border-t pt-4">
              {NOTIFICATION_CATEGORIES.map((category) => (
                <div key={category.key} className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Label htmlFor={`notify-${category.key}`}>{category.label}</Label>
                    <p className="text-muted-foreground mt-1 text-sm">{category.description}</p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 pt-1">
                    {saving && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
                    <Switch
                      id={`notify-${category.key}`}
                      checked={preferences[category.key]}
                      disabled={!settings || saving}
                      onCheckedChange={(checked) => setCategory(category.key, checked)}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </div>
  );
}
