"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Key,
  Loader2,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Shield,
  ChevronDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { postJson, deleteJson } from "@/lib/http";
import type { ConfiguredProvider, ProviderInfo } from "../types";

interface ProviderManagementProps {
  onModelsChanged: () => void;
}

export function ProviderManagement({ onModelsChanged }: ProviderManagementProps) {
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [globalProviders, setGlobalProviders] = useState<ConfiguredProvider[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [newProvider, setNewProvider] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [discoveryInfo, setDiscoveryInfo] = useState<{ count: number; error?: string } | null>(
    null,
  );

  const loadAll = useCallback(async () => {
    try {
      const providersRes = await fetch("/api/providers").then((r) => r.json());
      setProviders(providersRes.providers ?? []);
      setGlobalProviders(providersRes.globalProviders ?? []);
      setAvailableProviders(providersRes.availableProviders ?? []);
      onModelsChanged();
    } finally {
      setLoading(false);
    }
  }, [onModelsChanged]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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
    setAdding(true);
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
      await loadAll();
    } catch {
      setStatus("error");
    }
    setAdding(false);
  };

  const handleRemove = async (provider: string) => {
    try {
      await deleteJson(`/api/providers?provider=${encodeURIComponent(provider)}`);
      await loadAll();
    } catch (err) {
      console.error("Failed to delete provider:", err);
    }
  };

  const totalProviders = providers.length + globalProviders.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Key className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">API Keys</span>
        {totalProviders > 0 && (
          <Badge variant="secondary" className="rounded-full">
            {totalProviders}
          </Badge>
        )}
      </div>

      <div className="space-y-4">
        {/* Add form */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1 space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <div className="relative">
              <button
                type="button"
                className="border-border/50 inline-flex h-8 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-2.5 text-sm outline-hidden transition-colors hover:bg-white/10 dark:hover:bg-white/5"
                onClick={() => setProviderOpen(!providerOpen)}
              >
                <span className="truncate text-sm">
                  {availableProviders.find((p) => p.id === newProvider)?.name ?? (
                    <span className="text-muted-foreground">Select…</span>
                  )}
                </span>
                <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              </button>
              {providerOpen && (
                <div className="liquid-glass absolute top-full z-50 mt-1 w-full overflow-hidden rounded-lg border-0 shadow-2xl">
                  {availableProviders.map((p) => (
                    <button
                      key={p.id}
                      className={cn(
                        "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                        p.id === newProvider
                          ? "bg-primary/10 font-medium"
                          : "hover:bg-white/10 dark:hover:bg-white/5",
                      )}
                      onClick={() => {
                        setNewProvider(p.id);
                        setProviderOpen(false);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label className="text-xs">API Key</Label>
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                placeholder="sk-…"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                className="h-8 pr-8 font-mono text-xs"
              />
              <button
                type="button"
                className="text-muted-foreground absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2"
                onClick={() => setShowApiKey((v) => !v)}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {newProvider === "custom" && (
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input
                placeholder="http://localhost:11434/v1"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          )}

          <div className="min-w-[120px] space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input
              placeholder="optional"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <Button
            size="sm"
            className="h-8"
            onClick={handleAdd}
            disabled={adding || !newProvider || (newProvider === "custom" && !newBaseUrl)}
          >
            {adding ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </div>

        {/* Status messages */}
        <div className="flex items-center gap-3">
          {status === "success" && (
            <span className="flex items-center gap-1 text-xs text-emerald-500">
              <CheckCircle className="h-3.5 w-3.5" /> Added
            </span>
          )}
          {status === "error" && (
            <span className="flex items-center gap-1 text-xs text-red-500">
              <AlertCircle className="h-3.5 w-3.5" /> Failed
            </span>
          )}
          {discoveryInfo && discoveryInfo.count > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Sparkles className="h-3.5 w-3.5" />
              {discoveryInfo.count} models discovered
            </span>
          )}
          {discoveryInfo && discoveryInfo.error && (
            <span className="flex items-center gap-1 text-xs text-amber-500">
              <AlertCircle className="h-3.5 w-3.5" /> {discoveryInfo.error}
            </span>
          )}
        </div>

        {/* Configured providers */}
        {(globalProviders.length > 0 || providers.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {globalProviders.map((p) => (
              <div
                key={"global-" + p.provider}
                className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/5 px-2.5 py-1"
              >
                <Shield className="h-3 w-3 text-blue-500" />
                <span className="text-xs text-blue-600 dark:text-blue-400">{p.displayName}</span>
                <span className="text-[10px] text-blue-400/60">global</span>
              </div>
            ))}
            {providers.map((p) => (
              <div
                key={p.provider}
                className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1"
              >
                <Key className="h-3 w-3 text-emerald-500" />
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  {p.displayName}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-red-500"
                  onClick={() => handleRemove(p.provider)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {loading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
      </div>
    </div>
  );
}
