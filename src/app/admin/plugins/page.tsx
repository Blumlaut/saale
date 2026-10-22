"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageTabStrip } from "@/components/layout/page";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { PluginInfo, PluginListResult, PluginLogEntry, PluginUpdate } from "@/lib/pi/plugins";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Loader2,
  Puzzle,
  RefreshCw,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  Trash2,
  CloudDownload,
} from "lucide-react";

interface PluginResponse extends PluginListResult {
  log: PluginLogEntry[];
}

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

export default function AdminPluginsPage() {
  const [tab, setTab] = useState<"plugins" | "config" | "logs">("plugins");
  const [data, setData] = useState<PluginResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "reload" | "updates" | "clear">(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, PluginUpdate> | null>(null);

  // Config form state, seeded from the server.
  const [dir, setDir] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [switches, setSwitches] = useState<Record<string, boolean>>({});

  const apply = useCallback((next: PluginResponse) => {
    setData(next);
    setDir(next.config.dirSetting);
    setEnabled(next.config.enabled);
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
      setNotice({
        tone: "success",
        text: result.updates.length ? "Checked the git checkouts" : "No git checkouts to check",
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

  const plugins = data?.plugins ?? [];
  const errorCount = data?.log.filter((entry) => entry.level === "error").length ?? 0;

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
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as typeof tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center justify-between gap-2">
          <PageTabStrip className="min-w-0 flex-1">
            <TabsList>
              <TabsTrigger value="plugins" className="gap-2">
                <Puzzle className="h-4 w-4" />
                Plugins
              </TabsTrigger>
              <TabsTrigger value="config" className="gap-2">
                <SlidersHorizontal className="h-4 w-4" />
                Configuration
              </TabsTrigger>
              <TabsTrigger value="logs" className="gap-2">
                <ScrollText className="h-4 w-4" />
                Logs
                {errorCount > 0 && (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">
                    {errorCount}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </PageTabStrip>
          {notice && (
            <span
              className={cn(
                "hidden shrink-0 items-center gap-1 text-xs md:flex",
                notice.tone === "success"
                  ? "text-green-600 dark:text-green-400"
                  : "text-destructive",
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
        </div>

        {/* ─── Plugins ─── */}
        <TabsContent value="plugins" className="mt-4 min-h-0 flex-1 overflow-hidden">
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
                  className="h-8 w-8"
                  aria-label="Refresh"
                  disabled={busy !== null}
                  onClick={() => void load()}
                >
                  <RefreshCw className={cn("h-4 w-4", busy === "save" && "animate-spin")} />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-8 w-8 md:w-auto md:px-3"
                  aria-label="Check for updates"
                  disabled={busy !== null}
                  onClick={() => void checkUpdates()}
                >
                  {busy === "updates" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CloudDownload className="h-4 w-4" />
                  )}
                  <span className="hidden md:inline">Check updates</span>
                </Button>
                <Button
                  size="icon"
                  className="h-8 w-8 md:w-auto md:px-3"
                  aria-label="Rebuild sessions"
                  disabled={busy !== null}
                  onClick={() => void reloadSessions()}
                >
                  {busy === "reload" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}
                  <span className="hidden md:inline">Rebuild sessions</span>
                </Button>
              </div>
            </div>

            {!data?.config.enabled && (
              <div className="text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-xs">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Global plugins are off. Nothing below is loaded into a session.
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
                    Add a folder to <span className="font-mono break-all">{data?.config.dir}</span>{" "}
                    with an <span className="font-mono">index.ts</span>, an{" "}
                    <span className="font-mono">extensions/</span> folder, or a{" "}
                    <span className="font-mono">package.json</span> listing{" "}
                    <span className="font-mono">pi.extensions</span>. Reload this page afterwards.
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
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">{plugin.name}</span>
                              {plugin.version && (
                                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                                  v{plugin.version}
                                </span>
                              )}
                              <Badge variant="outline" className={cn("shrink-0", badge.className)}>
                                {badge.label}
                              </Badge>
                              {update && update.behind !== null && update.behind > 0 && (
                                <Badge variant="outline" className="shrink-0">
                                  {update.behind} behind
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
                          <div className="px-4 pb-3">
                            <div className="liquid-glass-inner space-y-3 rounded-lg p-3 text-xs">
                              <div className="min-w-0">
                                <p className="console-label">Path</p>
                                <p className="font-mono break-all">{plugin.path}</p>
                              </div>
                              {plugin.entries.length > 0 && (
                                <div className="min-w-0">
                                  <p className="console-label">Entries</p>
                                  {plugin.entries.map((entry) => (
                                    <p key={entry} className="font-mono break-all">
                                      {entry}
                                    </p>
                                  ))}
                                </div>
                              )}
                              {plugin.dependencies.length > 0 && (
                                <div className="min-w-0">
                                  <p className="console-label">Dependencies</p>
                                  <p className="font-mono break-all">
                                    {plugin.dependencies.join(", ")}
                                  </p>
                                </div>
                              )}
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="min-w-0">
                                  <p className="console-label">Changed</p>
                                  <p className="font-mono">
                                    {formatDate(plugin.updatedAt) ?? "unknown"} · {plugin.revision}
                                  </p>
                                </div>
                                {plugin.git ? (
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
                              </div>
                              {update && (
                                <div className="min-w-0">
                                  <p className="console-label">Upstream</p>
                                  <p className="font-mono break-all">
                                    {update.error
                                      ? update.error
                                      : update.behind === 0
                                        ? `Up to date with ${update.upstream}`
                                        : `${update.behind} commit(s) behind ${update.upstream}`}
                                  </p>
                                </div>
                              )}
                              {plugin.warnings.map((warning, index) => (
                                <div
                                  key={`${index}-${warning}`}
                                  className="text-yellow-700 dark:text-yellow-500"
                                >
                                  <p className="console-label">Warning</p>
                                  <p className="break-words">{warning}</p>
                                </div>
                              ))}
                              {plugin.errors.map((error, index) => (
                                <div key={`${index}-${error}`} className="text-destructive">
                                  <p className="console-label">Error</p>
                                  <p className="break-words">{error}</p>
                                </div>
                              ))}
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
        </TabsContent>

        {/* ─── Configuration ─── */}
        <TabsContent value="config" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <GlassPanel>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
              <p className="console-label">Plugin configuration</p>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void save(
                    {
                      dir,
                      enabled,
                      plugins: Object.fromEntries(
                        Object.entries(switches).map(([id, on]) => [id, on]),
                      ),
                    },
                    "Configuration saved",
                  )
                }
              >
                {busy === "save" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </div>

            <GlassPanelContent className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label className="text-sm font-medium">Load global plugins</Label>
                  <p className="text-muted-foreground text-xs">
                    Every session gets the plugins below. Turning this off loads none of them.
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Load global plugins"
                />
              </div>

              <Separator />

              <div className="space-y-1.5">
                <Label htmlFor="plugins-dir" className="text-sm font-medium">
                  Plugin directory
                </Label>
                <Input
                  id="plugins-dir"
                  value={dir}
                  onChange={(event) => setDir(event.target.value)}
                  placeholder={data?.config.dir}
                  className="font-mono"
                />
                <p className="text-muted-foreground text-xs">
                  Leave empty to use <span className="font-mono">PI_GLOBAL_PLUGINS_DIR</span>, then
                  the uploads volume. Currently reading{" "}
                  <span className="font-mono break-all">{data?.config.dir}</span>
                </p>
              </div>

              <Separator />

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Plugins</p>
                {plugins.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    Nothing in the directory yet. Add a plugin folder, then reload this page.
                  </p>
                ) : (
                  plugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="flex items-center justify-between gap-3 rounded-lg py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{plugin.name}</p>
                        <p className="text-muted-foreground truncate font-mono text-[11px]">
                          {plugin.id}
                        </p>
                      </div>
                      <Switch
                        checked={switches[plugin.id] ?? true}
                        onCheckedChange={(next) =>
                          setSwitches((current) => ({ ...current, [plugin.id]: next }))
                        }
                        aria-label={`Enable ${plugin.name}`}
                      />
                    </div>
                  ))
                )}
              </div>
            </GlassPanelContent>
          </GlassPanel>

          <GlassPanel className="mt-4">
            <GlassPanelHeader title="What a plugin can do" />
            <GlassPanelContent className="text-muted-foreground space-y-2 text-xs">
              <p>
                A plugin is a Pi extension: it can add tools, hook prompts and tool calls, add model
                providers and read session history.
              </p>
              <p>
                It runs inside this process with the server&apos;s permissions and can reach every
                account&apos;s data. Only install code you have reviewed. A plugin that throws is
                logged and skipped; it never fails a session.
              </p>
              <p>
                Changes apply to sessions built after the change. Rebuild sessions to apply them to
                chats that are already open.
              </p>
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>

        {/* ─── Logs ─── */}
        <TabsContent value="logs" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <GlassPanel className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
              <div className="min-w-0">
                <p className="console-label">Plugin log</p>
                <p className="text-muted-foreground truncate text-xs">
                  Load and runtime errors from this process
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Refresh"
                  disabled={busy !== null}
                  onClick={() => void load()}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-8 w-8 md:w-auto md:px-3"
                  aria-label="Clear log"
                  disabled={busy !== null}
                  onClick={() => void clearLog()}
                >
                  {busy === "clear" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  <span className="hidden md:inline">Clear</span>
                </Button>
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
        </TabsContent>
      </Tabs>

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
    </Page>
  );
}
