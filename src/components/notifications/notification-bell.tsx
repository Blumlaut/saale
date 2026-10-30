"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bell, CheckCircle, AlertCircle, Mail, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { fetchJson, patchJson } from "@/lib/http";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await fetchJson<{ notifications: Notification[] }>("/api/notifications");
      setNotifications(data.notifications || []);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const markAsRead = async (id: string) => {
    try {
      await patchJson("/api/notifications", { ids: [id] });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch {
      // Ignore
    }
  };

  const markAllAsRead = async () => {
    try {
      await patchJson("/api/notifications", { all: true });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // Ignore
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const getIcon = (type: string) => {
    switch (type) {
      case "email":
        return <Mail className="h-3.5 w-3.5" />;
      case "job_completed":
        return <CheckCircle className="h-3.5 w-3.5" />;
      case "job_error":
        return <AlertCircle className="h-3.5 w-3.5" />;
      default:
        return <Bell className="h-3.5 w-3.5" />;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* PopoverTrigger renders as <button>. use a styled <span> to avoid nesting */}
      <PopoverTrigger>
        <span className="hover:bg-accent/60 relative flex h-8 w-8 items-center justify-center rounded-full transition-colors">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full p-0 text-[10px]"
            >
              {unreadCount}
            </Badge>
          )}
        </span>
      </PopoverTrigger>

      <PopoverContent side="bottom" align="end" sideOffset={4} className="w-80 gap-0 p-0">
        <div className="dark:border-border flex items-center justify-between border-b border-white/20 px-4 py-3">
          <span className="text-sm font-medium">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              className="liquid-glass-pill h-7 rounded-full px-2.5 text-xs font-medium"
              onClick={markAllAsRead}
            >
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center text-sm">No notifications</div>
          ) : (
            notifications.map((notification) => (
              <div
                key={notification.id}
                className={cn(
                  "border-border hover:bg-accent/60 dark:border-border dark:hover:bg-muted/50 flex items-start gap-3 border-b px-4 py-3 transition-colors",
                  !notification.read && "bg-muted/50",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 rounded-full p-1.5",
                    !notification.read ? "bg-primary/10 text-primary" : "text-muted-foreground",
                  )}
                >
                  {getIcon(notification.type)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{notification.title}</div>
                  <div className="text-muted-foreground text-xs">{notification.message}</div>
                  <div className="text-muted-foreground/60 mt-1 text-xs">
                    {formatRelativeDate(notification.createdAt)}
                  </div>
                </div>
                {!notification.read && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 rounded-full"
                    onClick={() => markAsRead(notification.id)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
