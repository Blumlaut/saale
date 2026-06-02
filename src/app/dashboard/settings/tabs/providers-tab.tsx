"use client";

import { useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson, deleteJson } from "@/lib/http";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Key,
  Loader2,
  CheckCircle,
  AlertCircle,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Shield,
  Sparkles,
} from "lucide-react";
import type { ConfiguredProvider, ProviderInfo } from "../types";

interface ProvidersTabProps {
  providers: ConfiguredProvider[];
  availableProviders: ProviderInfo[];
  providersLoading: boolean;
  onReload: () => Promise<void>;
}

export function ProvidersTab({
  providers,
  availableProviders,
  providersLoading,
  onReload,
}: ProvidersTabProps) {
  const [newProvider, setNewProvider] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [discoveryInfo, setDiscoveryInfo] = useState<{ count: number; error?: string } | null>(
    null,
  );

  // Auto-clear statuses
  useEffect(() => {
    if (status !== "idle") {
      const t = setTimeout(() => setStatus("idle"), 3000);
      return () => clearTimeout(t);
    }
  }, [status]);

  useEffect(() => {
    if (discoveryInfo) {
      const t = setTimeout(() => setDiscoveryInfo(null), 8000);
      return () => clearTimeout(t);
    }
  }, [discoveryInfo]);

  const handleAdd = async () => {
    if (!newProvider) return;
    if (newProvider === "custom" && !newBaseUrl) return;
    setAddingProvider(true);
    try {
      const data = await postJson<{ modelCount?: number; modelError?: string }>("/api/providers", {
        provider: newProvider,
        apiKey: newApiKey,
        label: newLabel,
        baseUrl: newProvider === "custom" ? newBaseUrl : undefined,
      });
      setStatus("success");
      setNewApiKey("");
      setNewLabel("");
      setNewBaseUrl("");
      setNewProvider("");
      if (data.modelCount !== undefined) {
        const info: { count: number; error?: string } = { count: data.modelCount };
        if (data.modelError) info.error = data.modelError;
        setDiscoveryInfo(info);
      }
      await onReload();
    } catch {
      setStatus("error");
    }
    setAddingProvider(false);
  };

  const handleRemove = async (provider: string) => {
    try {
      await deleteJson(`/api/providers?provider=${encodeURIComponent(provider)}`);
      await onReload();
    } catch {
      // silently fail
    }
  };

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Key className="h-5 w-5" />
            API Keys
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Add your API keys to enable AI model providers. Keys are encrypted at rest.
          </p>
        </div>

        {/* Add new provider */}
        <div className="border-border/50 bg-background/40 space-y-4 rounded-2xl border p-5">
          <h4 className="text-sm font-medium">Add Provider</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider-select">Provider</Label>
              <Select value={newProvider} onValueChange={(v) => setNewProvider(v ?? "")}>
                <SelectTrigger id="provider-select">
                  {availableProviders.find((p) => p.id === newProvider)?.name ?? (
                    <SelectValue placeholder="Select provider" />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {availableProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key">
                API Key <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <div className="relative">
                <Input
                  id="api-key"
                  type={showApiKey ? "text" : "password"}
                  placeholder="sk-... or leave empty for local servers"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {newProvider === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="base-url">Base URL</Label>
              <Input
                id="base-url"
                placeholder="http://ollama.home.blumlaut.me/v1"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-muted-foreground text-xs">
                Base URL including /v1 path, e.g. https://api.openai.com/v1
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="provider-label">Label (optional)</Label>
            <Input
              id="provider-label"
              placeholder="e.g. Work account"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={addingProvider || !newProvider || (newProvider === "custom" && !newBaseUrl)}
            >
              {addingProvider ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add Key
            </Button>
            {status === "success" && (
              <span className="flex items-center gap-1 text-sm text-emerald-500">
                <CheckCircle className="h-4 w-4" />
                Saved
              </span>
            )}
            {status === "error" && (
              <span className="flex items-center gap-1 text-sm text-red-500">
                <AlertCircle className="h-4 w-4" />
                Failed
              </span>
            )}
            {discoveryInfo && discoveryInfo.count > 0 && (
              <span className="flex items-center gap-1 text-sm text-blue-500">
                <Sparkles className="h-4 w-4" />
                {discoveryInfo.count} models discovered
              </span>
            )}
            {discoveryInfo && discoveryInfo.error && (
              <span className="flex items-center gap-1 text-sm text-amber-500">
                <AlertCircle className="h-4 w-4" />
                {discoveryInfo.error}
              </span>
            )}
          </div>
        </div>

        {/* Configured providers */}
        {providersLoading ? (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        ) : providers.length === 0 ? (
          <div className="border-border/50 rounded-2xl border border-dashed p-8 text-center">
            <Shield className="text-muted-foreground/50 mx-auto h-8 w-8" />
            <p className="text-muted-foreground mt-3 text-sm">
              No API keys configured yet. Add one above to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => (
              <div
                key={p.provider}
                className="border-border/50 bg-background/40 flex items-center justify-between rounded-2xl border p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-xl">
                    <Key className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{p.displayName}</p>
                    <p className="text-muted-foreground text-xs">
                      {p.label || p.provider}
                      {p.label ? ` (${p.provider})` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-500">
                    <CheckCircle className="h-3 w-3" />
                    Configured
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground h-8 w-8 hover:text-red-500"
                    onClick={() => handleRemove(p.provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Info */}
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs text-amber-600 dark:text-amber-400">
            <Shield className="mr-1 inline h-3.5 w-3.5" />
            API keys are encrypted with AES-256-GCM before storage. They are only decrypted in
            memory when creating an AI session.
          </p>
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
