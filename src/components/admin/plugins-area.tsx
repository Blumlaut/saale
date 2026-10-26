"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PluginInstallDialog,
  PluginUninstallDialog,
  type PluginResponse,
} from "@/components/admin/plugin-dialogs";
import { Page } from "@/components/layout/page";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { PluginInfo, PluginLogEntry, PluginUpdate } from "@/lib/pi/plugins";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  CloudDownload,
  FolderOpen,
  GitBranch,
  Info,
  Loader2,
  MoreHorizontal,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Trash2,
} from "lucide-react";

const STATUS_BADGE: Record<PluginInfo["status"], { label: string; className: string }> = {
  loaded: { label: "Loaded", className: "border-green-600/40 text-green-700 dark:text-green-400" },
  error: { label: "Error", className: "border-destructive/40 text-destructive" },
  disabled: { label: "Off", className: "text-muted-foreground" },
  unknown: { label: "Not loaded", className: "text-muted-foreground" },
};

const LOG_BADGE: Record<PluginLogEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "border-yellow-600/40 text-yellow-700 dark:text-yellow-500",
  error: "border-destructive/40 text-destructive",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** Panel toolbar button: icon-only on a phone, icon and label from `md` up. */
function ToolbarButton({
  icon,
  label,
  variant = "secondary",
  busy = false,
  disabled = false,
  className,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant={variant === "primary" ? "default" : variant}
      size="sm"
      className={cn("h-8 w-8 shrink-0 gap-0 px-0 md:w-auto md:gap-2 md:px-3", className)}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

/** A one-line explanation behind an info icon. */
function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className="text-muted-foreground hover:text-foreground inline-flex"
        aria-label={text}
      >
        <Info className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

export type PluginsSection = "installed" | "configuration" | "logs";

/** One page of the Plugins area. The section is the route, not a tab. */
export function PluginsArea({ section }: { section: PluginsSection }) {
  const [data, setData] = useState<PluginResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "reload" | "updates" | "clear" | "install">(
    null,
  );
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, PluginUpdate> | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState<PluginInfo | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Config form state, seeded from the server.
  const [dir, setDir] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [ui, setUi] = useState(false);
  const [switches, setSwitches] = useState<Record<string, boolean>>({});

  const apply = useCallback((next: PluginResponse) => {
    setData(next);
    setDir(next.config.dirSetting);
    setEnabled(next.config.enabled);
    setUi(next.config.ui);
    setSwitches(
      Object.fromEntries(next.plugins.map((plugin) => [plugin.id, plugin.override ?? true])),
    );
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await fetchJson<PluginResponse>("/api/admin/plugins");
      apply(next);
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load plugins:", err);
      setLoadError(err instanceof Error ? err.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const save = useCallback(
    async (patch: Record<string, unknown>, message: string) => {
      setBusy("save");
      try {
        const next = await patchJson<PluginResponse>("/api/admin/plugins", patch);
        apply(next);
        setNotice({ tone: "success", text: message });
      } catch (err) {
        console.error("Failed to save plugin settings:", err);
        setNotice({
          tone: "error",
          text: err instanceof Error ? err.message : "Could not save the plugin settings",
        });
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  const togglePlugin = (plugin: PluginInfo, next: boolean) => {
    setSwitches((current) => ({ ...current, [plugin.id]: next }));
    void save(
      { plugins: { ...switches, [plugin.id]: next } },
      `${plugin.name} ${next ? "enabled" : "disabled"}`,
    );
  };

  const reloadSessions = async () => {
    setBusy("reload");
    try {
      const result = await postJson<{ evicted: number }>("/api/admin/plugins/reload", {});
      await load();
      setNotice({
        tone: "success",
        text: `Rebuilt ${result.evicted} session${result.evicted === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.error("Failed to rebuild sessions:", err);
      setNotice({ tone: "error", text: "Could not rebuild the sessions" });
    } finally {
      setBusy(null);
    }
  };

  const checkUpdates = async () => {
    setBusy("updates");
    try {
      const result = await postJson<{ updates: PluginUpdate[] }>("/api/admin/plugins/updates", {});
      setUpdates(Object.fromEntries(result.updates.map((entry) => [entry.id, entry])));
      const outdated = result.updates.filter((entry) => entry.outdated).length;
      setNotice({
        tone: "success",
        text:
          result.updates.length === 0
            ? "Nothing to check"
            : outdated === 0
              ? "Everything is up to date"
              : `${outdated} update${outdated === 1 ? "" : "s"} available`,
      });
    } catch (err) {
      console.error("Failed to check plugin updates:", err);
      setNotice({ tone: "error", text: "Could not check for updates" });
    } finally {
      setBusy(null);
    }
  };

  const clearLog = async () => {
    setBusy("clear");
    try {
      await deleteJson("/api/admin/plugins/log");
      await load();
    } catch (err) {
      console.error("Failed to clear the plugin log:", err);
      setNotice({ tone: "error", text: "Could not clear the log" });
    } finally {
      setBusy(null);
    }
  };

  const installSpec = async (spec: string, message: string) => {
    setBusy("install");
    try {
      const next = await postJson<PluginResponse & { installed: PluginInfo }>(
        "/api/admin/plugins/install",
        { spec },
      );
      apply(next);
      setUpdates(null);
      setNotice({ tone: "success", text: `${message} ${next.installed.name}` });
    } catch (err) {
      console.error("Failed to install a plugin:", err);
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not install the package",
      });
    } finally {
      setBusy(null);
    }
  };

  const plugins = data?.plugins ?? [];
  const dirDirty = dir.trim() !== (data?.config.dirSetting ?? "");

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Page>
        <GlassPanel>
          <GlassPanelContent className="flex flex-col items-center gap-3 py-10 text-center">
            <AlertCircle className="text-destructive h-6 w-6" />
            <p className="text-sm">{loadError}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </GlassPanelContent>
        </GlassPanel>
      </Page>
    );
  }

  return (
    <Page>
      {notice && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-end gap-1 px-1 text-xs",
            notice.tone === "success" ? "text-green-600 dark:text-green-400" : "text-destructive",
          )}
        >
          {notice.tone === "success" ? (
            <CheckCircle className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {notice.text}
        </span>
      )}

      {/* ─── Installed ─── */}
      {section === "installed" && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <GlassPanel className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
              <div className="min-w-0">
                <p className="console-label">Global plugins</p>
                <p className="text-muted-foreground truncate font-mono text-[11px]">
                  {data?.config.dir}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden h-8 w-8 md:inline-flex"
                  aria-label="Refresh"
                  title="Refresh"
                  disabled={busy !== null}
                  onClick={() => void load()}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <ToolbarButton
                  icon={<PackagePlus className="h-4 w-4" />}
                  label="Install"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => setInstallOpen(true)}
                />
                <ToolbarButton
                  icon={<CloudDownload className="h-4 w-4" />}
                  label="Check updates"
                  busy={busy === "updates"}
                  disabled={busy !== null}
                  onClick={() => void checkUpdates()}
                  className="hidden md:inline-flex"
                />
                <ToolbarButton
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Rebuild sessions"
                  busy={busy === "reload"}
                  disabled={busy !== null}
                  onClick={() => void reloadSessions()}
                  className="hidden md:inline-flex"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <span
                      className="hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-lg md:hidden"
                      title="More actions"
                      aria-label="More actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => void load()} disabled={busy !== null}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Refresh
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void checkUpdates()} disabled={busy !== null}>
                      <CloudDownload className="mr-2 h-4 w-4" />
                      Check updates
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void reloadSessions()}
                      disabled={busy !== null}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      Rebuild sessions
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {!data?.config.enabled && (
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Plugins are disabled globally.
                </span>
                <Button variant="link" size="xs" className="h-auto p-0" asChild>
                  <Link href="/admin/plugins/configuration">Enable</Link>
                </Button>
              </div>
            )}

            {(data?.diagnostics.length ?? 0) > 0 && (
              <div className="text-destructive border-b px-4 py-2 text-xs">
                <p className="console-label">Plugin set</p>
                {data?.diagnostics.map((diagnostic, index) => (
                  <p key={`${index}-${diagnostic}`} className="break-words">
                    {diagnostic}
                  </p>
                ))}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {plugins.length === 0 ? (
                <GlassPanelContent className="flex flex-col items-center gap-2 py-10 text-center">
                  <FolderOpen className="text-muted-foreground h-6 w-6" />
                  <p className="text-sm font-medium">No plugins installed</p>
                  <p className="text-muted-foreground max-w-md text-xs">
                    Install one from npm, or drop a folder with an{" "}
                    <span className="font-mono">index.ts</span> into the directory above.
                  </p>
                  {!data?.config.dirExists && (
                    <p className="text-muted-foreground text-xs">
                      The directory does not exist yet.
                    </p>
                  )}
                </GlassPanelContent>
              ) : (
                <div>
                  {plugins.map((plugin, index) => {
                    const badge = STATUS_BADGE[plugin.status];
                    const update = updates?.[plugin.id];
                    const isOpen = expanded === plugin.id;
                    return (
                      <div key={plugin.id}>
                        {index > 0 && <Separator />}
                        <div className="flex items-start gap-3 px-4 py-3">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => setExpanded(isOpen ? null : plugin.id)}
                            aria-expanded={isOpen}
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="truncate text-sm font-medium">{plugin.name}</span>
                              {plugin.version && (
                                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                                  v{plugin.version}
                                </span>
                              )}
                              <Badge variant="outline" className={cn("shrink-0", badge.className)}>
                                {badge.label}
                              </Badge>
                              {update?.outdated && (
                                <Badge variant="outline" className="shrink-0">
                                  {update.latest ? `v${update.latest}` : `${update.behind} behind`}
                                </Badge>
                              )}
                            </div>
                            <p className="text-muted-foreground mt-0.5 truncate text-xs">
                              {plugin.description ?? plugin.entries[0] ?? plugin.id}
                            </p>
                          </button>
                          <Switch
                            checked={switches[plugin.id] ?? true}
                            disabled={busy !== null || !data?.config.enabled}
                            onCheckedChange={(next) => togglePlugin(plugin, next)}
                            aria-label={`Enable ${plugin.name}`}
                            className="mt-1 shrink-0"
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            aria-label={isOpen ? "Hide details" : "Show details"}
                            onClick={() => setExpanded(isOpen ? null : plugin.id)}
                          >
                            <ChevronDown
                              className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                            />
                          </Button>
                        </div>

                        {isOpen && (
                          <div className="space-y-3 px-4 pb-3">
                            {plugin.errors.map((error, index) => (
                              <div key={`${index}-${error}`} className="text-destructive text-xs">
                                <p className="console-label">Error</p>
                                <p className="break-words">{error}</p>
                              </div>
                            ))}
                            {plugin.warnings.map((warning, index) => (
                              <div
                                key={`${index}-${warning}`}
                                className="text-xs text-yellow-700 dark:text-yellow-500"
                              >
                                <p className="console-label">Warning</p>
                                <p className="break-words">{warning}</p>
                              </div>
                            ))}

                            <div className="liquid-glass-inner space-y-3 rounded-lg p-3 text-xs">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="min-w-0">
                                  <p className="console-label">Changed</p>
                                  <p className="font-mono">
                                    {formatDate(plugin.updatedAt) ?? "unknown"} · {plugin.revision}
                                  </p>
                                </div>
                                {plugin.kind === "package" ? (
                                  <div className="min-w-0">
                                    <p className="console-label">Source</p>
                                    <p className="font-mono break-all">npm · {plugin.id}</p>
                                  </div>
                                ) : plugin.git ? (
                                  <div className="min-w-0">
                                    <p className="console-label">Git</p>
                                    <p className="flex items-center gap-1 font-mono break-all">
                                      <GitBranch className="h-3 w-3 shrink-0" />
                                      {plugin.git.branch ?? "detached"} · {plugin.git.commit}
                                      {plugin.git.dirty && " · modified"}
                                    </p>
                                  </div>
                                ) : (
                                  <div className="min-w-0">
                                    <p className="console-label">Updates</p>
                                    <p className="text-muted-foreground">
                                      Local folder, updated by copying files in
                                    </p>
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <p className="console-label">Path</p>
                                  <p className="font-mono break-all">{plugin.path}</p>
                                </div>
                                <div className="min-w-0">
                                  <p className="console-label">Entries</p>
                                  {plugin.entries.map((entry) => (
                                    <p key={entry} className="font-mono break-all">
                                      {entry}
                                    </p>
                                  ))}
                                </div>
                              </div>

                              {update?.error && (
                                <p className="text-muted-foreground break-words">{update.error}</p>
                              )}
                              {update?.outdated && update.latest && plugin.kind === "package" && (
                                <p className="text-muted-foreground">
                                  {update.latest} is published.
                                </p>
                              )}
                              {update?.outdated && update.behind !== null && update.behind > 0 && (
                                <p className="text-muted-foreground">
                                  {update.behind} commit{update.behind === 1 ? "" : "s"} behind{" "}
                                  {update.upstream}
                                </p>
                              )}

                              <div className="flex flex-wrap items-center gap-2">
                                {plugin.kind === "package" && update?.outdated && (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    className="h-7"
                                    disabled={busy !== null}
                                    onClick={() =>
                                      void installSpec(`npm:${plugin.id}@latest`, "Updated")
                                    }
                                  >
                                    {busy === "install" ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <CloudDownload className="h-3.5 w-3.5" />
                                    )}
                                    Update to v{update.latest}
                                  </Button>
                                )}
                                {plugin.kind === "package" ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive h-7"
                                    disabled={busy !== null}
                                    onClick={() => setUninstalling(plugin)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Uninstall
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </GlassPanel>
        </div>
      )}

      {/* ─── Configuration ─── */}
      {section === "configuration" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GlassPanel>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
              <p className="console-label">Plugin configuration</p>
              {dirDirty && (
                <Button
                  size="sm"
                  className="h-8"
                  disabled={busy !== null}
                  onClick={() => void save({ dir }, "Directory saved")}
                >
                  {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save
                </Button>
              )}
            </div>

            <GlassPanelContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Label htmlFor="plugins-enabled" className="text-sm font-medium">
                    Enabled
                  </Label>
                  <Hint text="Every session loads the plugins below." />
                </div>
                <Switch
                  id="plugins-enabled"
                  checked={enabled}
                  onCheckedChange={(next) => {
                    setEnabled(next);
                    void save(
                      { enabled: next },
                      next ? "Plugins enabled" : "Plugins disabled globally",
                    );
                  }}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Label htmlFor="plugins-ui" className="text-sm font-medium">
                    Dialogs in the chat
                  </Label>
                  <Hint text="A plugin can ask a question through ctx.ui. The chat shows it, and the run waits for the answer." />
                </div>
                <Switch
                  id="plugins-ui"
                  checked={ui}
                  onCheckedChange={(next) => {
                    setUi(next);
                    void save(
                      { ui: next },
                      next ? "Plugins may open dialogs" : "Plugins cannot open dialogs",
                    );
                  }}
                />
              </div>

              <Separator />

              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="plugins-dir" className="text-sm font-medium">
                    Directory
                  </Label>
                  <Hint text="Empty falls back to PI_GLOBAL_PLUGINS_DIR, then the uploads volume." />
                </div>
                <Input
                  id="plugins-dir"
                  value={dir}
                  onChange={(event) => setDir(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && dirDirty) void save({ dir }, "Directory saved");
                  }}
                  placeholder={data?.config.dir}
                  className="font-mono"
                />
                {dirDirty && (
                  <p className="text-muted-foreground truncate font-mono text-[11px]">
                    Reading {data?.config.dir}
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-1">
                <p className="text-sm font-medium">Plugins</p>
                {plugins.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    Nothing installed. Install one from npm, or drop a folder in the directory.
                  </p>
                ) : (
                  plugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="flex items-center justify-between gap-3 rounded-lg py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{plugin.name}</p>
                        {(plugin.name !== plugin.id || plugin.kind === "package") && (
                          <p className="text-muted-foreground truncate font-mono text-[11px]">
                            {plugin.kind === "package" ? `npm · ${plugin.id}` : plugin.id}
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={switches[plugin.id] ?? true}
                        disabled={busy !== null || !enabled}
                        onCheckedChange={(next) => togglePlugin(plugin, next)}
                        aria-label={`Enable ${plugin.name}`}
                      />
                    </div>
                  ))
                )}
              </div>
            </GlassPanelContent>
          </GlassPanel>

          <Collapsible
            open={aboutOpen}
            onOpenChange={setAboutOpen}
            className="mt-4 rounded-lg border"
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left">
              <span className="text-sm font-medium">What a plugin can do</span>
              <ChevronDown
                className={cn(
                  "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
                  aboutOpen && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="text-muted-foreground space-y-2 border-t px-4 py-3 text-xs">
              <p>
                A plugin is a Pi extension: it adds tools, hooks prompts and tool calls, and can
                read session history.
              </p>
              <p>
                It runs inside this process with the server&apos;s permissions, so install only code
                you have reviewed.
              </p>
              <p>A plugin that throws is logged and skipped. It never fails a session.</p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {/* ─── Logs ─── */}
      {section === "logs" && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <GlassPanel className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
              <div className="min-w-0">
                <p className="console-label">Plugin log</p>
                <p className="text-muted-foreground truncate text-xs">
                  Load and runtime errors from this process
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <ToolbarButton
                  icon={<RefreshCw className="h-4 w-4" />}
                  label="Refresh"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void load()}
                />
                <ToolbarButton
                  icon={<Trash2 className="h-4 w-4" />}
                  label="Clear"
                  busy={busy === "clear"}
                  disabled={busy !== null}
                  onClick={() => void clearLog()}
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {(data?.log.length ?? 0) === 0 ? (
                <GlassPanelContent className="flex flex-col items-center gap-2 py-10 text-center">
                  <ScrollText className="text-muted-foreground h-6 w-6" />
                  <p className="text-sm font-medium">Nothing logged</p>
                  <p className="text-muted-foreground max-w-md text-xs">
                    A plugin that fails to load, or a handler that throws during a session, is
                    recorded here.
                  </p>
                </GlassPanelContent>
              ) : (
                <div>
                  {data?.log.map((entry, index) => (
                    <div key={entry.id}>
                      {index > 0 && <Separator />}
                      <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-start sm:gap-2">
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-muted-foreground font-mono text-[11px]">
                            {formatTime(entry.at)}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn("shrink-0 uppercase", LOG_BADGE[entry.level])}
                          >
                            {entry.level}
                          </Badge>
                          {entry.pluginId && (
                            <span className="truncate font-mono text-[11px]">{entry.pluginId}</span>
                          )}
                        </div>
                        <span className="min-w-0 flex-1 text-xs break-words">{entry.message}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </GlassPanel>
        </div>
      )}

      {notice && (
        <p
          className={cn(
            "flex shrink-0 items-center gap-1 px-2 text-xs md:hidden",
            notice.tone === "success" ? "text-green-600 dark:text-green-400" : "text-destructive",
          )}
        >
          {notice.tone === "success" ? (
            <CheckCircle className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {notice.text}
        </p>
      )}

      <PluginInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={(response, installed) => {
          apply(response);
          setUpdates(null);
          setNotice({ tone: "success", text: `Installed ${installed.name}` });
        }}
      />

      <PluginUninstallDialog
        plugin={uninstalling}
        onOpenChange={(open) => {
          if (!open) setUninstalling(null);
        }}
        onRemoved={(response) => {
          apply(response);
          setUpdates(null);
          setNotice({ tone: "success", text: "Plugin removed" });
        }}
      />
    </Page>
  );
}
