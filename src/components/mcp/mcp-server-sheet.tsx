"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/shared/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  PlugZap,
  Trash2,
} from "lucide-react";
import {
  isMcpTransport,
  MCP_ENV_MAX_VARS,
  MCP_ENV_VALUE_MAX_BYTES,
  normalizeMcpServerName,
  validateMcpCommand,
  validateMcpCwd,
  validateMcpServerName,
  validateMcpUrl,
  type McpToolPolicy,
  type McpTransport,
} from "@/lib/mcp/shared";
import { envNameError, envValueBytes } from "@/lib/sandbox/env-rules";
import { findMcpPreset, MCP_PRESETS } from "@/lib/mcp/presets";
import type {
  McpOAuthStart,
  McpOAuthStatus,
  McpServer,
  McpServerInput,
  McpTestResult,
} from "@/hooks/use-mcp-servers";

/** How often the sheet asks whether a browser sign-in has finished. */
const OAUTH_POLL_INTERVAL_MS = 1_500;

/** The inputs whose validation message can appear under them. */
type ManagedField = "name" | "url" | "command" | "cwd";

/** One policy per server: the default for every tool it contributes. */
const POLICY_OPTIONS: { value: McpToolPolicy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Ask for approval before running a tool" },
  { value: "allow", label: "Allow", hint: "Run tools automatically" },
  { value: "off", label: "Block", hint: "Never run tools from this server" },
];

/** How the server is reached, as the sheet offers it. */
const TRANSPORT_OPTIONS: { value: McpTransport; label: string; hint: string }[] = [
  { value: "http", label: "Endpoint URL", hint: "An MCP endpoint hosted anywhere." },
  {
    value: "stdio",
    label: "Command in workspace",
    hint: "A program run in your workspace that speaks MCP over stdin.",
  },
];

interface McpServerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server being edited, or null when adding. */
  server: McpServer | null;
  onSave: (input: McpServerInput) => Promise<unknown>;
  /** Connect to an unsaved or edited server and list its tools. Omit to hide the test. */
  onTest?: (
    id: string,
    input: {
      transport: McpTransport;
      url?: string;
      token?: string;
      command?: string;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => Promise<McpTestResult>;
  /**
   * Whether a command is on offer. An instance's shared server is reachable for
   * every account, and a command belongs to one workspace, so the admin's form
   * leaves this out.
   */
  allowStdio?: boolean;
  /**
   * A browser sign-in belongs to one account, so the admin's shared-server form
   * leaves all three of these out and the sheet shows no sign-in block.
   */
  onStartOAuth?: (id: string) => Promise<McpOAuthStart>;
  onOAuthStatus?: (id: string) => Promise<McpOAuthStatus>;
  onSignOutOAuth?: (id: string) => Promise<void>;
}

export function McpServerSheet({
  open,
  onOpenChange,
  server,
  onSave,
  onTest,
  allowStdio = false,
  onStartOAuth,
  onOAuthStatus,
  onSignOutOAuth,
}: McpServerSheetProps) {
  /** The sheet offers a sign-in only where every part of it is available. */
  const canSignIn = Boolean(onStartOAuth && onOAuthStatus && onSignOutOAuth);
  const isEditing = server !== null;

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState("");
  /**
   * The command's variables. A stored value never comes back, so the sheet lists
   * names and holds only the values typed in this visit: saving sets those and
   * removes the names taken off the list.
   */
  const [storedEnvNames, setStoredEnvNames] = useState<string[]>([]);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [removedEnvNames, setRemovedEnvNames] = useState<string[]>([]);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const [envError, setEnvError] = useState<string | null>(null);
  /** Names a preset asked for that have no value yet, with what the value is. */
  const [wantedEnv, setWantedEnv] = useState<{ name: string; what: string }[]>([]);
  /** The note a chosen preset leaves under the fields. */
  const [presetNote, setPresetNote] = useState<string | null>(null);

  const [toolPolicy, setToolPolicy] = useState<McpToolPolicy>("ask");
  const [enabled, setEnabled] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [coderEnabled, setCoderEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  /** Which input a validation message belongs to, rendered under it. */
  const [fieldError, setFieldError] = useState<{
    field: ManagedField;
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  /** OAuth sign-in state for a saved server. */
  const [hasOAuth, setHasOAuth] = useState(false);
  const [oauthPhase, setOauthPhase] = useState<"idle" | "pending" | "succeeded" | "failed">("idle");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  /**
   * Result of folding what the user typed into a name Pi accepts. Folding
   * happens when the field is left rather than on every keystroke: a fold that
   * drops trailing separators would swallow the space in "HA Admin" before it
   * could become an underscore, and re-writing the value mid-edit moves the
   * caret.
   */
  const foldedName = normalizeMcpServerName(name);

  /**
   * Counts the times the sheet has been opened, closed, or moved to another
   * server. A sign-in or test started in an earlier one answers into a sheet the
   * user has already left, so its result is dropped rather than written onto the
   * server now on screen.
   */
  const session = useRef(0);
  const stillCurrent = useCallback((startedAt: number) => session.current === startedAt, []);

  /** The names the command will start with: what is stored, what was added, less what was removed. */
  const envNames = [
    ...new Set([...storedEnvNames, ...Object.keys(envValues), ...wantedEnv.map((v) => v.name)]),
  ]
    .filter((name) => !removedEnvNames.includes(name))
    .sort();

  /** Fill the sheet from a preset, leaving each variable's value to the user. */
  const applyPreset = (id: string) => {
    const preset = findMcpPreset(id);
    if (!preset) return;

    setName(preset.name);
    setTransport(preset.transport);
    setUrl(preset.url ?? "");
    setCommand(preset.command ?? "");
    setCwd(preset.cwd ?? "");
    setDescription(preset.description);
    setEnvValues({});
    setRemovedEnvNames([]);
    setStoredEnvNames([]);
    setWantedEnv(preset.variables ?? []);
    setPresetNote(preset.note ?? null);
    setNewEnvName("");
    setNewEnvValue("");
    setEnvError(null);
    setTestResult(null);
  };

  const addEnvVariable = () => {
    const name = newEnvName.trim();
    const nameError = envNameError(name);
    if (nameError) {
      setEnvError(nameError);
      return;
    }
    if (!newEnvValue) {
      setEnvError("Give the variable a value.");
      return;
    }
    const valueError =
      envValueBytes(newEnvValue) > MCP_ENV_VALUE_MAX_BYTES
        ? `A value can be at most ${MCP_ENV_VALUE_MAX_BYTES} bytes.`
        : null;
    if (valueError) {
      setEnvError(valueError);
      return;
    }
    if (envNames.length >= MCP_ENV_MAX_VARS && !envNames.includes(name)) {
      setEnvError(`A server can carry at most ${MCP_ENV_MAX_VARS} variables.`);
      return;
    }

    setEnvValues((current) => ({ ...current, [name]: newEnvValue }));
    setWantedEnv((current) => current.filter((variable) => variable.name !== name));
    setRemovedEnvNames((current) => current.filter((removed) => removed !== name));
    setNewEnvName("");
    setNewEnvValue("");
    setEnvError(null);
  };

  const removeEnvVariable = (name: string) => {
    setEnvValues((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    setWantedEnv((current) => current.filter((variable) => variable.name !== name));
    setRemovedEnvNames((current) =>
      storedEnvNames.includes(name) && !current.includes(name) ? [...current, name] : current,
    );
    setEnvError(null);
  };

  /** Clear the message under a field once the user edits it again. */
  const clearFieldError = (field: ManagedField) => {
    setFieldError((current) => (current?.field === field ? null : current));
  };

  useEffect(() => {
    session.current += 1;
    if (!open) return;
    setName(server?.name ?? "");
    setTransport(server?.transport ?? "http");
    setUrl(server?.url ?? "");
    setCommand(server?.command ?? "");
    setCwd(server?.cwd ?? "");
    setDescription(server?.description ?? "");
    setToken("");
    setStoredEnvNames(server?.envNames ?? []);
    setEnvValues({});
    setRemovedEnvNames([]);
    setNewEnvName("");
    setNewEnvValue("");
    setEnvError(null);
    setWantedEnv([]);
    setPresetNote(null);
    setToolPolicy(server?.toolPolicy ?? "ask");
    setEnabled(server?.enabled ?? true);
    setChatEnabled(server?.chatEnabled ?? true);
    setCoderEnabled(server?.coderEnabled ?? true);
    setError(null);
    setFieldError(null);
    setTestResult(null);
    setHasOAuth(server?.hasOAuth ?? false);
    setOauthPhase("idle");
    setOauthUrl(null);
    setOauthError(null);
    setOauthBusy(false);
  }, [open, server]);

  // Follow a browser sign-in until it settles or the sheet closes.
  useEffect(() => {
    const serverId = server?.id;
    if (!open || oauthPhase !== "pending" || !serverId || !onOAuthStatus) return;

    let cancelled = false;
    const poll = setInterval(() => {
      void (async () => {
        try {
          const status = await onOAuthStatus(serverId);
          if (cancelled) return;
          if (status.status === "succeeded") {
            setHasOAuth(true);
            setOauthPhase("succeeded");
            setOauthUrl(null);
          } else if (status.status === "failed") {
            setOauthPhase("failed");
            setOauthError(status.error ?? "The sign-in failed.");
          }
        } catch (err) {
          // A lost poll is not a failed sign-in: keep the last state.
          console.error("Failed to read the MCP OAuth sign-in state:", err);
        }
      })();
    }, OAUTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [open, oauthPhase, server?.id, onOAuthStatus]);

  const handleTest = useCallback(async () => {
    if (!onTest) return;
    const problem =
      transport === "stdio"
        ? { field: "command" as const, message: validateMcpCommand(command.trim()) }
        : { field: "url" as const, message: validateMcpUrl(url.trim()) };
    if (problem.message) {
      setFieldError({ field: problem.field, message: problem.message });
      return;
    }

    const startedAt = session.current;
    setTesting(true);
    setError(null);
    setFieldError(null);
    setTestResult(null);
    try {
      // An unchanged stored token is represented by an empty field: let the
      // server use the credential it already has.
      const result = await onTest(
        server?.id ?? "new",
        transport === "stdio"
          ? {
              transport,
              command: command.trim(),
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(Object.keys(envValues).length > 0 ? { env: envValues } : {}),
            }
          : {
              transport,
              url: url.trim(),
              ...(token.trim() ? { token: token.trim() } : {}),
            },
      );
      if (!stillCurrent(startedAt)) return;
      setTestResult(result);
      if (!result.success && result.error) setError(result.error);
    } finally {
      setTesting(false);
    }
  }, [command, cwd, envValues, onTest, server, stillCurrent, token, transport, url]);

  const handleSignIn = useCallback(async () => {
    if (!server || !onStartOAuth) return;
    const startedAt = session.current;
    setOauthBusy(true);
    setOauthError(null);
    setTestResult(null);
    try {
      const result = await onStartOAuth(server.id);
      if (!stillCurrent(startedAt)) return;
      if (result.status === "succeeded") {
        setHasOAuth(true);
        setOauthPhase("succeeded");
        return;
      }
      if (!result.authorizationUrl) {
        setOauthPhase("failed");
        setOauthError("The server did not return a sign-in URL.");
        return;
      }
      setOauthUrl(result.authorizationUrl);
      setOauthPhase("pending");
      // Best effort: a blocked popup still leaves the link below.
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      if (!stillCurrent(startedAt)) return;
      setOauthPhase("failed");
      setOauthError((err as Error).message || "Failed to start the sign-in");
    } finally {
      setOauthBusy(false);
    }
  }, [onStartOAuth, server, stillCurrent]);

  const handleSignOut = useCallback(async () => {
    if (!server || !onSignOutOAuth) return;
    const startedAt = session.current;
    setOauthBusy(true);
    setOauthError(null);
    try {
      await onSignOutOAuth(server.id);
      if (!stillCurrent(startedAt)) return;
      setHasOAuth(false);
      setOauthPhase("idle");
      setOauthUrl(null);
    } catch (err) {
      if (!stillCurrent(startedAt)) return;
      setOauthError((err as Error).message || "Failed to sign out");
    } finally {
      setOauthBusy(false);
    }
  }, [onSignOutOAuth, server, stillCurrent]);

  const handleSave = useCallback(async () => {
    const normalizedName = normalizeMcpServerName(name);

    const nameError = validateMcpServerName(normalizedName);
    if (nameError) {
      setFieldError({ field: "name", message: nameError });
      return;
    }

    const trimmedCommand = command.trim();
    const trimmedCwd = cwd.trim();
    const trimmedUrl = url.trim();
    const missing = wantedEnv.filter(
      (wanted) => !envValues[wanted.name] && !storedEnvNames.includes(wanted.name),
    );
    if (missing.length > 0) {
      setEnvError(`Give ${missing[0]!.name} a value.`);
      return;
    }
    if (transport === "stdio") {
      const commandError = validateMcpCommand(trimmedCommand);
      if (commandError) {
        setFieldError({ field: "command", message: commandError });
        return;
      }
      const cwdError = validateMcpCwd(trimmedCwd);
      if (cwdError) {
        setFieldError({ field: "cwd", message: cwdError });
        return;
      }
    } else {
      const urlError = validateMcpUrl(trimmedUrl);
      if (urlError) {
        setFieldError({ field: "url", message: urlError });
        return;
      }
    }

    setSaving(true);
    setError(null);
    setFieldError(null);
    const startedAt = session.current;
    try {
      await onSave(
        transport === "stdio"
          ? {
              name: normalizedName,
              transport,
              command: trimmedCommand,
              cwd: trimmedCwd,
              ...(Object.keys(envValues).length > 0 ? { env: envValues } : {}),
              ...(removedEnvNames.length > 0 ? { envRemove: removedEnvNames } : {}),
              description: description.trim(),
              toolPolicy,
              enabled,
              chatEnabled,
              coderEnabled,
            }
          : {
              name: normalizedName,
              transport,
              url: trimmedUrl,
              description: description.trim(),
              toolPolicy,
              enabled,
              chatEnabled,
              coderEnabled,
              // An empty field leaves an existing token alone; a typed value
              // replaces it. Clearing is offered explicitly below.
              ...(token.trim() ? { token: token.trim() } : {}),
            },
      );
      // Closing here would shut the sheet of the server the user moved on to.
      if (!stillCurrent(startedAt)) return;
      onOpenChange(false);
    } catch (err) {
      if (!stillCurrent(startedAt)) return;
      setError((err as Error).message || "Failed to save the server");
    } finally {
      setSaving(false);
    }
  }, [
    chatEnabled,
    command,
    coderEnabled,
    cwd,
    description,
    enabled,
    envValues,
    name,
    storedEnvNames,
    wantedEnv,
    onOpenChange,
    onSave,
    removedEnvNames,
    stillCurrent,
    token,
    toolPolicy,
    transport,
    url,
  ]);

  const handleClearToken = useCallback(async () => {
    if (!server) return;
    const startedAt = session.current;
    setSaving(true);
    setError(null);
    try {
      await onSave({ token: "" });
      if (!stillCurrent(startedAt)) return;
      setToken("");
    } catch (err) {
      if (!stillCurrent(startedAt)) return;
      setError((err as Error).message || "Failed to clear the token");
    } finally {
      setSaving(false);
    }
  }, [onSave, server, stillCurrent]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {isEditing ? "Edit MCP server" : "Add MCP server"}
            </SheetTitle>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {!isEditing && (
              <div className="space-y-2">
                <Label className="text-sm">Start from a preset</Label>
                <Select value="" onValueChange={(value) => value && applyPreset(value)}>
                  <SelectTrigger className="w-full" aria-label="Start from a preset">
                    <SelectValue>
                      {(value) => findMcpPreset(value)?.label ?? "Pick a server"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MCP_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Fills in the command and the variables the server needs. Every field stays
                  editable.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-sm">Name</Label>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearFieldError("name");
                }}
                onBlur={() => setName(foldedName)}
                placeholder="homeassistant"
                autoComplete="off"
              />
              {fieldError?.field === "name" ? (
                <p className="text-destructive text-xs">{fieldError.message}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Names this server&apos;s tools. Spaces and punctuation become underscores, e.g.{" "}
                  <span className="break-all">{`mcp__${foldedName || "homeassistant"}__HassTurnOn`}</span>
                </p>
              )}
            </div>

            {allowStdio && (
              <div className="space-y-2">
                <Label className="text-sm">Connection</Label>
                <Select
                  value={transport}
                  onValueChange={(value) => {
                    if (!isMcpTransport(value)) return;
                    setTransport(value);
                    setFieldError(null);
                    setTestResult(null);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Connection">
                    <SelectValue>
                      {(value) =>
                        TRANSPORT_OPTIONS.find((option) => option.value === value)?.label ??
                        "Endpoint URL"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSPORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {TRANSPORT_OPTIONS.find((option) => option.value === transport)?.hint}
                </p>
              </div>
            )}

            {transport === "stdio" ? (
              <>
                <div className="space-y-2">
                  <Label className="text-sm">Command</Label>
                  <Input
                    value={command}
                    onChange={(event) => {
                      setCommand(event.target.value);
                      clearFieldError("command");
                    }}
                    className="font-mono text-xs"
                    placeholder="npx -y @modelcontextprotocol/server-filesystem ."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {fieldError?.field === "command" ? (
                    <p className="text-destructive text-xs">{fieldError.message}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Runs in your workspace container as you, so it reaches your files and the
                      variables below. The first run may download packages.
                    </p>
                  )}
                  {presetNote && <p className="text-muted-foreground text-xs">{presetNote}</p>}
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">Working directory</Label>
                  <Input
                    value={cwd}
                    onChange={(event) => {
                      setCwd(event.target.value);
                      clearFieldError("cwd");
                    }}
                    className="font-mono text-xs"
                    placeholder="Optional, e.g. docs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {fieldError?.field === "cwd" ? (
                    <p className="text-destructive text-xs">{fieldError.message}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Where the command starts, relative to your workspace root.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">Variables</Label>
                  {envNames.length > 0 && (
                    <ul className="space-y-1.5">
                      {envNames.map((variable) => {
                        const wanted = wantedEnv.find((entry) => entry.name === variable);
                        return (
                          <li
                            key={variable}
                            className="bg-muted/50 border-border space-y-1.5 rounded-lg border px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <KeyRound className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {variable}
                              </span>
                              {!wanted && (
                                <span className="text-muted-foreground shrink-0 text-[11px]">
                                  {envValues[variable] ? "new value" : "stored"}
                                </span>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 shrink-0 px-1.5 text-[11px]"
                                onClick={() => removeEnvVariable(variable)}
                                aria-label={`Remove ${variable}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            {wanted && (
                              <Input
                                type="password"
                                value={envValues[variable] ?? ""}
                                onChange={(event) => {
                                  const typed = event.target.value;
                                  setEnvValues((current) => ({ ...current, [variable]: typed }));
                                  setEnvError(null);
                                }}
                                placeholder={wanted.what}
                                className="h-8 text-xs"
                                autoComplete="off"
                                aria-label={`Value of ${variable}`}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={newEnvName}
                      onChange={(event) => {
                        setNewEnvName(event.target.value);
                        setEnvError(null);
                      }}
                      placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                      className="min-w-0 flex-1 font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Variable name"
                    />
                    <Input
                      type="password"
                      value={newEnvValue}
                      onChange={(event) => {
                        setNewEnvValue(event.target.value);
                        setEnvError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addEnvVariable();
                        }
                      }}
                      placeholder="Value"
                      className="min-w-0 flex-1 text-xs"
                      autoComplete="off"
                      aria-label="Variable value"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 shrink-0 px-2.5 text-xs"
                      onClick={addEnvVariable}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="sr-only">Add variable</span>
                    </Button>
                  </div>
                  {envError ? (
                    <p className="text-destructive text-xs">{envError}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Read by this command, on top of your variables in Integrations. Stored
                      encrypted, and never shown again.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label className="text-sm">Endpoint URL</Label>
                  <Input
                    value={url}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      clearFieldError("url");
                    }}
                    placeholder="https://homeassistant.local:8123/api/mcp"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {fieldError?.field === "url" ? (
                    <p className="text-destructive text-xs">{fieldError.message}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">A streamable HTTP MCP endpoint.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">Access token</Label>
                  <Input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={server?.hasToken ? "Type to replace stored value" : "Optional"}
                    autoComplete="off"
                  />
                  <p className="text-muted-foreground text-xs">
                    Sent as <span className="font-mono">Authorization: Bearer …</span>. Stored
                    encrypted.
                  </p>
                  {server?.hasToken && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleClearToken}
                      disabled={saving}
                    >
                      Remove stored token
                    </Button>
                  )}
                </div>

                {canSignIn && (
                  <div className="space-y-2">
                    <Label className="text-sm">OAuth sign-in</Label>
                    {!isEditing ? (
                      <p className="text-muted-foreground text-xs">
                        Save this server first, then sign in here.
                      </p>
                    ) : oauthPhase === "pending" ? (
                      <div className="space-y-2">
                        <p className="text-muted-foreground flex items-center gap-2 text-xs">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Waiting for you to finish signing in…
                        </p>
                        {oauthUrl && (
                          <div className="bg-muted border-border flex items-start gap-2 rounded-lg border px-3 py-2">
                            <code className="min-w-0 flex-1 text-[11px] break-all">{oauthUrl}</code>
                            <CopyButton text={oauthUrl} label="Copy the sign-in URL" />
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {oauthUrl && (
                            <Button size="sm" variant="secondary" asChild>
                              <a href={oauthUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="h-3.5 w-3.5" />
                                Open sign-in page
                              </a>
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={handleSignIn}
                            disabled={oauthBusy}
                          >
                            Start over
                          </Button>
                        </div>
                      </div>
                    ) : hasOAuth || oauthPhase === "succeeded" ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                          <CheckCircle className="h-3.5 w-3.5" />
                          Signed in
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleSignOut}
                          disabled={oauthBusy}
                        >
                          Sign out
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-9 text-xs font-medium"
                          onClick={handleSignIn}
                          disabled={oauthBusy}
                        >
                          {oauthBusy ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ExternalLink className="mr-2 h-3.5 w-3.5" />
                          )}
                          Sign in
                        </Button>
                        <p className="text-muted-foreground text-xs">
                          For servers that ask clients to sign in. A stored access token is used
                          instead of OAuth.
                        </p>
                      </div>
                    )}
                    {oauthError && <p className="text-destructive text-xs">{oauthError}</p>}
                  </div>
                )}
              </>
            )}

            <div className="space-y-2">
              <Label className="text-sm">Description</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Control the smart home"
              />
              <p className="text-muted-foreground text-xs">
                One line telling the assistant what this server is for.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Tool approval</Label>
              <Select
                value={toolPolicy}
                onValueChange={(value) => {
                  if (value) setToolPolicy(value as McpToolPolicy);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      POLICY_OPTIONS.find((option) => option.value === value)?.label ?? "Ask"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {POLICY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {POLICY_OPTIONS.find((option) => option.value === toolPolicy)?.hint}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <Label className="text-sm">Enabled</Label>
                <p className="text-muted-foreground text-xs">
                  Connect this server to your conversations.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Connects in</Label>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm">Chat</p>
                  <p className="text-muted-foreground text-xs">
                    Conversations, Telegram and agent jobs.
                  </p>
                </div>
                <Switch
                  checked={chatEnabled}
                  onCheckedChange={setChatEnabled}
                  aria-label="Connect in chat"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm">Coder</p>
                  <p className="text-muted-foreground text-xs">Coding chats, in a worktree.</p>
                </div>
                <Switch
                  checked={coderEnabled}
                  onCheckedChange={setCoderEnabled}
                  aria-label="Connect in coder chats"
                />
              </div>
              {!chatEnabled && !coderEnabled && (
                <p className="text-muted-foreground text-xs">
                  This server connects nowhere. Turn on Chat or Coder.
                </p>
              )}
            </div>

            {error && (
              <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}

            {testResult?.success && (
              <div className="space-y-2 rounded-xl bg-green-500/10 px-4 py-3 text-sm text-green-600 dark:text-green-400">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">
                    Connected to {testResult.serverName ?? "the server"}:{" "}
                    {testResult.tools?.length ?? 0} tool
                    {testResult.tools?.length === 1 ? "" : "s"}
                  </span>
                </div>
                {testResult.tools && testResult.tools.length > 0 && (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {testResult.tools.map((tool) => (
                      <li key={tool.name} className="break-all">
                        {tool.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-2 border-t px-6 py-4">
            {onTest && (
              <Button
                type="button"
                variant="secondary"
                className="h-9 text-xs font-medium"
                onClick={handleTest}
                disabled={
                  testing || saving || !(transport === "stdio" ? command.trim() : url.trim())
                }
              >
                {testing ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlugZap className="mr-2 h-3.5 w-3.5" />
                )}
                Test
              </Button>
            )}
            <Button
              type="button"
              className="h-9 flex-1 text-xs font-medium"
              onClick={handleSave}
              disabled={
                saving ||
                testing ||
                !name.trim() ||
                !(transport === "stdio" ? command.trim() : url.trim())
              }
            >
              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {isEditing ? "Save changes" : "Add server"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
