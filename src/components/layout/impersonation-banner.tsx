"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/http";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { User, Loader2 } from "lucide-react";

interface SessionData {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  };
  session: {
    impersonatedBy?: string | null;
  };
}

export function ImpersonationBanner() {
  const router = useRouter();
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const data = await fetchJson<SessionData>("/api/auth/get-session");
      setSession(data);
    } catch {
      // Ignore — not authenticated
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Don't render if not impersonating
  if (loading || !session?.session?.impersonatedBy) {
    return null;
  }

  const handleStop = async () => {
    setStopping(true);
    try {
      await authClient.admin.stopImpersonating();
      // Navigate back to admin panel
      router.push("/admin/users");
    } catch (err) {
      console.error("Failed to stop impersonating:", err);
      setStopping(false);
    }
  };

  const displayName = session.user.name || session.user.email || "Unknown user";

  return (
    <div className="liquid-glass shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2">
      <div className="flex items-center gap-3">
        <Badge className="shrink-0 bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
          <User className="mr-1.5 h-3 w-3" />
          Impersonating
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm">
          Viewing as <span className="font-medium">{displayName}</span>
          {session.user.email && (
            <span className="text-muted-foreground"> ({session.user.email})</span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleStop} disabled={stopping}>
            {stopping ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Stop impersonating
          </Button>
        </div>
      </div>
    </div>
  );
}
