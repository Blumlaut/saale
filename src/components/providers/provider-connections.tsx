"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Key,
  Loader2,
  MoreVertical,
  Plus,
  ScanEye,
  Search,
  Shield,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import {
  ProviderLoginSheet,
  type ProviderLoginTarget,
} from "@/components/providers/provider-login-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { deleteJson, patchJson, postJson } from "@/lib/http";
import type { ProviderCatalogView } from "@/lib/providers/catalog";
import { CUSTOM_PROVIDER_ID } from "@/lib/providers/config";
import { PI_DEFAULT_CONTEXT_WINDOW, PI_DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/providers/limits";
import type { ProviderAuthType } from "@/lib/providers/login";
import { cn, ROW_ACTION } from "@/lib/utils";

/**
 * Which providers this scope has configured, and how to configure the rest.
 *
 * The list *is* Pi's provider catalog — Saale adds no providers of its own
 * except the OpenAI-compatible endpoint, which Pi cannot know about. Every other
 * row is connected by running Pi's own sign-in flow for that provider, so a
 * provider Pi gains is configurable here the day the package is updated.
 */

/** Feedback from the last endpoint import or capability probe. */
type DiscoveryInfo =
  | { kind: "import"; modelCount: number; visionModels?: number; error?: string }
  | {
      kind: "detect";
      modelCount: number;
      detected: number;
      visionModels: number;
      unprobed: number;
    };

export interface ConfiguredProviderRow {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  displayName: string;
}

interface ProviderConnectionsProps {
  /** Which credential scope the endpoints read and write. */
  scope: "user" | "global";
  /** Called after models may have changed (a sign-in, an import, a disconnect). */
  onChanged?: () => void;
}

/** The API surface for each scope — the only difference between user and admin. */
function endpointsFor(scope: "user" | "global") {
  const base = scope === "global" ? "/api/admin/providers" : "/api/providers";
  return {
    providers: base,
    login: `${base}/login`,
    answer: `${base}/login/answer`,
    capabilities: `${base}/capabilities`,
  };
}

export function ProviderConnections({ scope, onChanged }: ProviderConnectionsProps) {
  const endpoints = useMemo(() => endpointsFor(scope), [scope]);

  // Held in a ref so a caller's inline callback cannot change `loadAll`'s
  // identity — that would re-run the load effect on every render.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const [catalog, setCatalog] = useState<ProviderCatalogView[]>([]);
  const [rows, setRows] = useState<ConfiguredProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [loginTarget, setLoginTarget] = useState<ProviderLoginTarget | null>(null);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorText, setErrorText] = useState("");
  const [discoveryInfo, setDiscoveryInfo] = useState<DiscoveryInfo | null>(null);
  const [detecting, setDetecting] = useState<string | null>(null);

  // The OpenAI-compatible endpoint form (create and edit share these fields).
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const data = await fetch(endpoints.providers).then((response) => response.json());
      setCatalog(data.availableProviders ?? []);
      setRows(data.providers ?? []);
      onChangedRef.current?.();
    } catch (err) {
      console.error("Failed to load providers:", err);
    } finally {
      setLoading(false);
    }
  }, [endpoints.providers]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (status !== "idle") {
      const timer = setTimeout(() => setStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  useEffect(() => {
    if (discoveryInfo) {
      const timer = setTimeout(() => setDiscoveryInfo(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [discoveryInfo]);

  /**
   * The caller's own endpoint row. A globally configured endpoint is an admin's
   * — the form never prefills from it, so saving cannot copy it into a row of
   * the caller's own by accident.
   */
  const endpointRow = rows.find((row) => row.provider === CUSTOM_PROVIDER_ID) ?? null;

  const matches = (entry: ProviderCatalogView) =>
    search.trim().length === 0 ||
    entry.name.toLowerCase().includes(search.trim().toLowerCase()) ||
    entry.id.toLowerCase().includes(search.trim().toLowerCase());

  const connected = catalog.filter((entry) => entry.configured).filter(matches);
  const available = catalog.filter((entry) => !entry.configured).filter(matches);

  const handleConnect = (entry: ProviderCatalogView, authType: ProviderAuthType) => {
    setLoginTarget({ providerId: entry.id, providerName: entry.name, authType });
  };

  const handleDisconnect = async (provider: string) => {
    try {
      await deleteJson(`${endpoints.providers}?provider=${encodeURIComponent(provider)}`);
      await loadAll();
    } catch (err) {
      console.error("Failed to disconnect the provider:", err);
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Failed to disconnect");
    }
  };

  const openEndpointForm = () => {
    setApiKey("");
    setLabel(endpointRow?.label ?? "");
    setBaseUrl(endpointRow?.baseUrl ?? "");
    setContextWindow(endpointRow?.contextWindow ? String(endpointRow.contextWindow) : "");
    setMaxOutputTokens(endpointRow?.maxOutputTokens ? String(endpointRow.maxOutputTokens) : "");
    setEndpointOpen(true);
  };

  const handleSaveEndpoint = async () => {
    setSaving(true);
    try {
      const data = await postJson<{
        modelCount?: number;
        modelError?: string;
        visionModels?: number;
      }>(endpoints.providers, {
        provider: CUSTOM_PROVIDER_ID,
        apiKey,
        label,
        baseUrl,
        contextWindow: contextWindow || undefined,
        maxOutputTokens: maxOutputTokens || undefined,
      });
      setStatus("success");
      setEndpointOpen(false);
      if (data.modelCount !== undefined) {
        setDiscoveryInfo({
          kind: "import",
          modelCount: data.modelCount,
          ...(data.modelError ? { error: data.modelError } : {}),
          ...(data.visionModels ? { visionModels: data.visionModels } : {}),
        });
      }
      await loadAll();
    } catch (err) {
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Request failed");
    }
    setSaving(false);
  };

  const handleSaveLimits = async () => {
    try {
      await patchJson(endpoints.providers, {
        provider: CUSTOM_PROVIDER_ID,
        contextWindow: contextWindow || undefined,
        maxOutputTokens: maxOutputTokens || undefined,
      });
      setEndpointOpen(false);
      await loadAll();
    } catch (err) {
      console.error("Failed to save provider limits:", err);
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Failed to save limits");
    }
  };

  /**
   * Ask the endpoint what its models can do (image input, today) and store the
   * answers. A button rather than something automatic: most endpoints cannot
   * answer at all — llama.cpp's `/props` is the one that can — so a failed probe
   * must not be mistaken for "no model here sees images".
   */
  const handleDetectCapabilities = async () => {
    setDetecting(CUSTOM_PROVIDER_ID);
    try {
      const data = await postJson<{
        modelCount: number;
        detected: number;
        visionModels: number;
        unprobed: number;
      }>(endpoints.capabilities, { provider: CUSTOM_PROVIDER_ID });
      setDiscoveryInfo({
        kind: "detect",
        modelCount: data.modelCount,
        detected: data.detected,
        visionModels: data.visionModels,
        unprobed: data.unprobed,
      });
      onChangedRef.current?.();
    } catch (err) {
      console.error("Failed to detect provider capabilities:", err);
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Detection failed");
    }
    setDetecting(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Key className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Providers</span>
        {connected.length > 0 && (
          <Badge variant="secondary" className="rounded-full">
            {connected.length}
          </Badge>
        )}
      </div>

      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search providers…"
          className="h-8 pl-9 text-xs"
        />
      </div>

      {loading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}

      {!loading && connected.length > 0 && (
        <GlassPanel className="overflow-hidden p-0">
          {connected.map((entry, index) => (
            <div key={entry.id}>
              <ProviderRow
                entry={entry}
                readOnly={scope === "user" && entry.isGlobal}
                onConfigureEndpoint={openEndpointForm}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onEditEndpoint={openEndpointForm}
                onDetect={handleDetectCapabilities}
                detecting={detecting === entry.id}
              />
              {index < connected.length - 1 && <Separator className="px-4" />}
            </div>
          ))}
        </GlassPanel>
      )}

      {!loading && available.length > 0 && (
        <GlassPanel className="overflow-hidden p-0">
          <div className="text-muted-foreground border-b px-4 py-2 text-[11px] tracking-wide uppercase">
            Available
          </div>
          {available.map((entry, index) => (
            <div key={entry.id}>
              <ProviderRow
                entry={entry}
                readOnly={scope === "user" && entry.isGlobal}
                onConfigureEndpoint={openEndpointForm}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onEditEndpoint={openEndpointForm}
                onDetect={handleDetectCapabilities}
                detecting={detecting === entry.id}
              />
              {index < available.length - 1 && <Separator className="px-4" />}
            </div>
          ))}
        </GlassPanel>
      )}

      {/* Status + discovery feedback */}
      <div className="flex flex-wrap items-center gap-3">
        {status === "success" && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <CheckCircle className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {status === "error" && (
          <span className="flex items-center gap-1 text-xs text-red-500">
            <AlertCircle className="h-3.5 w-3.5" /> {errorText || "Failed"}
          </span>
        )}
        {discoveryInfo?.kind === "import" && discoveryInfo.modelCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-blue-500">
            {discoveryInfo.modelCount} models discovered
            {discoveryInfo.visionModels ? `, ${discoveryInfo.visionModels} with vision` : ""}
          </span>
        )}
        {discoveryInfo?.kind === "import" && discoveryInfo.error && (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <AlertCircle className="h-3.5 w-3.5" /> {discoveryInfo.error}
          </span>
        )}
        {discoveryInfo?.kind === "detect" && discoveryInfo.detected === 0 && (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <AlertCircle className="h-3.5 w-3.5" /> This endpoint reports no model capabilities —
            set vision per model in the list above
          </span>
        )}
        {discoveryInfo?.kind === "detect" && discoveryInfo.detected > 0 && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <ScanEye className="h-3.5 w-3.5" />
            {discoveryInfo.visionModels} of {discoveryInfo.modelCount} models accept images
          </span>
        )}
      </div>

      {/* The OpenAI-compatible endpoint — the one provider Pi does not define. */}
      {!endpointOpen ? (
        <Button variant="secondary" size="sm" className="h-8" onClick={openEndpointForm}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {endpointRow ? "Edit OpenAI-compatible endpoint" : "Add OpenAI-compatible endpoint"}
        </Button>
      ) : (
        <div className="border-border/50 space-y-3 rounded-lg border p-3">
          <span className="text-xs font-medium">OpenAI-compatible endpoint</span>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1 space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input
                placeholder="http://localhost:11434/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="min-w-[160px] flex-1 space-y-1.5">
              <Label className="text-xs">API key</Label>
              <Input
                type="password"
                placeholder="optional for a local server"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="min-w-[120px] space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                placeholder="optional"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="min-w-[130px] space-y-1.5">
              <Label className="text-xs">Context window</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                placeholder={String(PI_DEFAULT_CONTEXT_WINDOW)}
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="min-w-[130px] space-y-1.5">
              <Label className="text-xs">Max output tokens</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                placeholder={String(PI_DEFAULT_MAX_OUTPUT_TOKENS)}
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-[11px]">
            Limits are what Pi sends as the request&apos;s token budget for the models this endpoint
            serves. Leave them empty to use Pi&apos;s defaults (
            {PI_DEFAULT_CONTEXT_WINDOW.toLocaleString()} context /{" "}
            {PI_DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()} output); a larger cap than the endpoint
            allows is rejected by the provider.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8"
              onClick={handleSaveEndpoint}
              disabled={saving || !baseUrl}
            >
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
            {endpointRow && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={handleSaveLimits}
                disabled={saving}
              >
                Limits only
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setEndpointOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ProviderLoginSheet
        target={loginTarget}
        loginEndpoint={endpoints.login}
        answerEndpoint={endpoints.answer}
        onClose={() => setLoginTarget(null)}
        onConnected={() => {
          void loadAll();
        }}
      />
    </div>
  );
}

/** The auth methods of a provider, as the labels the row shows. */
function methodLabel(entry: ProviderCatalogView): string {
  const oauth = entry.methods.find((method) => method.type === "oauth");
  if (oauth) return oauth.subscription ? "Subscription" : "OAuth";
  return "API key";
}

interface ProviderRowProps {
  entry: ProviderCatalogView;
  /** Whether the caller may change this row (an inherited credential is read-only). */
  readOnly: boolean;
  /** Saale's own endpoint is configured in the form below, not by signing in. */
  onConfigureEndpoint: () => void;
  onConnect: (entry: ProviderCatalogView, authType: ProviderAuthType) => void;
  onDisconnect: (provider: string) => void;
  onEditEndpoint: () => void;
  onDetect: () => void;
  detecting: boolean;
}

function ProviderRow({
  entry,
  readOnly,
  onConfigureEndpoint,
  onConnect,
  onDisconnect,
  onEditEndpoint,
  onDetect,
  detecting,
}: ProviderRowProps) {
  return (
    <div className="group hover:bg-accent/60 flex items-center gap-3 px-4 py-3 transition-colors duration-150">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {entry.custom && (
            <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
              custom
            </Badge>
          )}
          {entry.configured && (
            <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
              {readOnly ? "global" : methodLabel(entry)}
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground block truncate text-xs">
          {entry.modelCount} {entry.modelCount === 1 ? "model" : "models"}
          {entry.baseUrl ? ` — ${entry.baseUrl}` : ""}
          {entry.methods.length > 1 ? " — API key or sign-in" : ""}
        </span>
      </div>

      {!entry.configured && entry.custom && !readOnly && (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={onConfigureEndpoint}
        >
          Configure
        </Button>
      )}

      {!entry.configured &&
        !entry.custom &&
        entry.methods.some((method) => method.type === "oauth") && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => onConnect(entry, "oauth")}
          >
            Sign in
          </Button>
        )}

      {!entry.configured &&
        !entry.custom &&
        !entry.methods.some((method) => method.type === "oauth") && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => onConnect(entry, "api_key")}
          >
            Connect
          </Button>
        )}

      {((entry.configured && !readOnly) || (!entry.configured && !entry.custom)) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(triggerProps) => (
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", ROW_ACTION)}
                {...triggerProps}
              >
                <MoreVertical className="h-3.5 w-3.5" />
                <span className="sr-only">Actions for {entry.name}</span>
              </Button>
            )}
          />
          <DropdownMenuContent align="end">
            {!entry.configured &&
              !entry.custom &&
              entry.methods.map((method) => (
                <DropdownMenuItem key={method.type} onClick={() => onConnect(entry, method.type)}>
                  {method.type === "oauth" ? (
                    <Shield className="mr-2 h-3.5 w-3.5" />
                  ) : (
                    <Key className="mr-2 h-3.5 w-3.5" />
                  )}
                  {method.label}
                </DropdownMenuItem>
              ))}
            {entry.custom && !readOnly && (
              <>
                <DropdownMenuItem onClick={onEditEndpoint}>
                  <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
                  Endpoint settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDetect} disabled={detecting}>
                  {detecting ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ScanEye className="mr-2 h-3.5 w-3.5" />
                  )}
                  Detect model capabilities
                </DropdownMenuItem>
              </>
            )}
            {entry.configured && !readOnly && (
              <DropdownMenuItem variant="destructive" onClick={() => onDisconnect(entry.id)}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Disconnect
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
