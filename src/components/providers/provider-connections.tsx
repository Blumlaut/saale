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
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import {
  EMPTY_ENDPOINT_DEFAULTS,
  ProviderAddSheet,
  type AddSheetMode,
  type EndpointDefaults,
  type EndpointDraft,
} from "@/components/providers/provider-add-sheet";
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
import { PageAction, PageActions } from "@/components/layout/page";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { deleteJson, patchJson, postJson } from "@/lib/http";
import type { ProviderCatalogView } from "@/lib/providers/catalog";
import { CUSTOM_PROVIDER_ID } from "@/lib/providers/config";
import type { ProviderAuthType } from "@/lib/providers/login";
import { cn, ROW_ACTION } from "@/lib/utils";

/**
 * Which providers this scope has linked, and how to link the rest.
 *
 * The list *is* Pi's provider catalog. Saale adds no providers of its own
 * except the OpenAI-compatible endpoint, which Pi cannot know about. Every other
 * row is connected by running Pi's own sign-in flow for that provider, so a
 * provider Pi gains is configurable here the day the package is updated.
 */

/** The add sheet's exit animation, so the sign-in sheet never opens on top of it. */
const SHEET_EXIT_MS = 200;

/** Feedback from the last endpoint import or capability probe. */
type DiscoveryInfo =
  | { kind: "import"; modelCount: number; visionModels?: number; error?: string }
  | {
      kind: "detect";
      modelCount: number;
      detected: number;
      /** How many of those accept images. */
      visionModels: number;
      /** How many came with a context window. */
      contextWindows: number;
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

/** The API surface for each scope. the only difference between user and admin. */
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
  // identity. that would re-run the load effect on every render.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const [catalog, setCatalog] = useState<ProviderCatalogView[]>([]);
  const [rows, setRows] = useState<ConfiguredProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddSheetMode>("browse");
  const [saving, setSaving] = useState(false);

  const [loginTarget, setLoginTarget] = useState<ProviderLoginTarget | null>(null);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorText, setErrorText] = useState("");
  const [discoveryInfo, setDiscoveryInfo] = useState<DiscoveryInfo | null>(null);
  const [detecting, setDetecting] = useState<string | null>(null);

  const loginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (loginTimer.current) clearTimeout(loginTimer.current);
    },
    [],
  );

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
   *. the form never prefills from it, so saving cannot copy it into a row of
   * the caller's own by accident.
   */
  const endpointRow = rows.find((row) => row.provider === CUSTOM_PROVIDER_ID) ?? null;

  const endpointDefaults = useMemo<EndpointDefaults>(() => {
    if (!endpointRow) return EMPTY_ENDPOINT_DEFAULTS;
    return {
      exists: true,
      apiKey: "",
      label: endpointRow.label,
      baseUrl: endpointRow.baseUrl ?? "",
      contextWindow: endpointRow.contextWindow ? String(endpointRow.contextWindow) : "",
      maxOutputTokens: endpointRow.maxOutputTokens ? String(endpointRow.maxOutputTokens) : "",
    };
  }, [endpointRow]);

  const linked = catalog.filter((entry) => entry.configured);

  const openAddSheet = () => {
    setAddMode("browse");
    setAddOpen(true);
  };

  const openEndpointForm = () => {
    setAddMode("endpoint");
    setAddOpen(true);
  };

  /** Unlink from inside the manage sheet. close it, then drop the credential. */
  const handleSheetDisconnect = (entry: ProviderCatalogView) => {
    setAddOpen(false);
    void handleDisconnect(entry.id);
  };

  const handleConnect = (entry: ProviderCatalogView, authType: ProviderAuthType) => {
    setAddOpen(false);
    // Wait for the picker to slide away. two overlays at once is never right.
    loginTimer.current = setTimeout(() => {
      setLoginTarget({ providerId: entry.id, providerName: entry.name, authType });
    }, SHEET_EXIT_MS);
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

  const handleSaveEndpoint = async (draft: EndpointDraft) => {
    setSaving(true);
    try {
      const data = await postJson<{
        modelCount?: number;
        modelError?: string;
        visionModels?: number;
      }>(endpoints.providers, {
        provider: CUSTOM_PROVIDER_ID,
        apiKey: draft.apiKey,
        label: draft.label,
        baseUrl: draft.baseUrl,
        contextWindow: draft.contextWindow || undefined,
        maxOutputTokens: draft.maxOutputTokens || undefined,
      });
      setStatus("success");
      setAddOpen(false);
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

  const handleSaveLimits = async (draft: EndpointDraft) => {
    setSaving(true);
    try {
      await patchJson(endpoints.providers, {
        provider: CUSTOM_PROVIDER_ID,
        contextWindow: draft.contextWindow || undefined,
        maxOutputTokens: draft.maxOutputTokens || undefined,
      });
      setAddOpen(false);
      await loadAll();
    } catch (err) {
      console.error("Failed to save provider limits:", err);
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Failed to save limits");
    }
    setSaving(false);
  };

  /**
   * Ask the endpoint about its models. the window each one runs at, and
   * whether it takes images. and store the answers.
   *
   * A button rather than something automatic: a load-on-demand proxy like
   * llama-swap charges a probe with a model load, so the sweep is the user's
   * call, and a failed probe must not be mistaken for "no model here sees
   * images".
   */
  const handleDetectCapabilities = async () => {
    setDetecting(CUSTOM_PROVIDER_ID);
    try {
      const data = await postJson<{
        modelCount: number;
        detected: number;
        visionModels: number;
        contextWindows: number;
        unprobed: number;
      }>(endpoints.capabilities, { provider: CUSTOM_PROVIDER_ID });
      setDiscoveryInfo({
        kind: "detect",
        modelCount: data.modelCount,
        detected: data.detected,
        visionModels: data.visionModels,
        contextWindows: data.contextWindows,
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
      <GlassPanel className="overflow-hidden p-0">
        <PageActions
          leading={
            <>
              <Key className="text-muted-foreground h-4 w-4" />
              <span className="text-sm font-medium">Providers</span>
              {linked.length > 0 && (
                <Badge variant="secondary" className="rounded-full">
                  {linked.length}
                </Badge>
              )}
            </>
          }
        >
          <PageAction icon={Plus} label="Manage providers" onClick={openAddSheet} />
        </PageActions>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          </div>
        ) : linked.length === 0 ? (
          <GlassPanelContent>
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Key className="text-muted-foreground/50 mb-3 h-7 w-7" />
              <p className="text-sm font-medium">No providers linked</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Connect a provider to use its models.
              </p>
              <Button variant="secondary" size="sm" className="mt-4 h-8" onClick={openAddSheet}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Manage providers
              </Button>
            </div>
          </GlassPanelContent>
        ) : (
          <div>
            {linked.map((entry, index) => (
              <div key={entry.id}>
                <ProviderRow
                  entry={entry}
                  readOnly={scope === "user" && entry.isGlobal}
                  onConfigureEndpoint={openEndpointForm}
                  onDisconnect={handleDisconnect}
                  onDetect={handleDetectCapabilities}
                  detecting={detecting === entry.id}
                />
                {index < linked.length - 1 && <Separator className="px-4" />}
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

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
            <AlertCircle className="h-3.5 w-3.5" /> This endpoint says nothing about its models set
            the window and vision per model in the model list
          </span>
        )}
        {discoveryInfo?.kind === "detect" && discoveryInfo.detected > 0 && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <ScanEye className="h-3.5 w-3.5" />
            {discoveryInfo.detected} of {discoveryInfo.modelCount} models described
            {discoveryInfo.contextWindows > 0
              ? `, ${discoveryInfo.contextWindows} with a window`
              : ""}
            {discoveryInfo.visionModels > 0 ? `, ${discoveryInfo.visionModels} with vision` : ""}
          </span>
        )}
      </div>

      <ProviderAddSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        providers={catalog}
        loading={loading}
        mode={addMode}
        endpoint={endpointDefaults}
        saving={saving}
        onConnect={handleConnect}
        onSaveEndpoint={(draft) => void handleSaveEndpoint(draft)}
        onSaveLimits={(draft) => void handleSaveLimits(draft)}
        scope={scope}
        onDisconnect={handleSheetDisconnect}
      />

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
  /** Saale's own endpoint is configured in the add sheet, not by signing in. */
  onConfigureEndpoint: () => void;
  onDisconnect: (provider: string) => void;
  onDetect: () => void;
  detecting: boolean;
}

function ProviderRow({
  entry,
  readOnly,
  onConfigureEndpoint,
  onDisconnect,
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
          <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
            {readOnly ? "global" : methodLabel(entry)}
          </Badge>
        </div>
        <span className="text-muted-foreground block truncate text-xs">
          {entry.modelCount} {entry.modelCount === 1 ? "model" : "models"}
          {entry.baseUrl ? `. ${entry.baseUrl}` : ""}
        </span>
      </div>

      {!readOnly && (
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
            {entry.custom && (
              <>
                <DropdownMenuItem onClick={onConfigureEndpoint}>
                  <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
                  Endpoint settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDetect} disabled={detecting}>
                  {detecting ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ScanEye className="mr-2 h-3.5 w-3.5" />
                  )}
                  Detect model limits
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => onDisconnect(entry.id)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
