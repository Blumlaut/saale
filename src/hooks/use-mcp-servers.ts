"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import type { McpToolPolicy, McpTransport } from "@/lib/mcp/shared";

export interface McpServer {
  id: string;
  name: string;
  /** `http` for a URL, `stdio` for a command in the workspace. */
  transport: McpTransport;
  /** The endpoint of an http server; null for a command server. */
  url: string | null;
  /** The command line of a command server; null for an http server. */
  command: string | null;
  /** Workspace-relative working directory of the command, or null for the root. */
  cwd: string | null;
  /** Names of the variables the command starts with. Values are never sent to the client. */
  envNames: string[];
  description: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  /** Whether the server connects in a chat. */
  chatEnabled: boolean;
  /** Whether the server connects in a coder chat. */
  coderEnabled: boolean;
  /** Whether a bearer token is stored. The token itself is never sent to the client. */
  hasToken: boolean;
  /** Whether an OAuth credential is stored for this server. */
  hasOAuth: boolean;
  /** Written by an admin for the whole instance: the account cannot edit it. */
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input for adding or updating a server. `token: ""` clears a stored token. */
export interface McpServerInput {
  name?: string;
  transport?: McpTransport;
  url?: string;
  command?: string;
  cwd?: string;
  /** Variables to set or replace, by name. */
  env?: Record<string, string>;
  /** Variables to forget, by name. */
  envRemove?: string[];
  description?: string;
  token?: string;
  toolPolicy?: McpToolPolicy;
  enabled?: boolean;
  chatEnabled?: boolean;
  coderEnabled?: boolean;
}

/** Result of a connection test: the server identity and the tools it offers. */
export interface McpTestResult {
  success: boolean;
  serverName?: string | null;
  serverVersion?: string | null;
  tools?: { name: string; description: string | null }[];
  error?: string;
  /** The server asked for an OAuth sign-in rather than accepting the request. */
  needsAuth?: boolean;
}

/** What an import added, and what it could not. */
export interface ImportedMcpServerList {
  created: McpServer[];
  skipped: { name: string; error: string }[];
}

/** The state of a server's OAuth sign-in, as the settings sheet polls it. */
export interface McpOAuthStatus {
  status: "idle" | "pending" | "succeeded" | "failed";
  error: string | null;
  authorizationUrl: string | null;
  hasOAuth: boolean;
}

/** What starting a sign-in returns: a URL to open, or an already-usable grant. */
export interface McpOAuthStart {
  status: "pending" | "succeeded";
  authorizationUrl: string | null;
}

/**
 * The user's MCP servers and the actions the settings page performs on them.
 * A server change evicts the user's pooled chats on the server side, so a
 * running conversation picks the change up on its next message.
 */
export function useMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    try {
      const data = await fetchJson<{ servers: McpServer[] }>("/api/mcp/servers");
      setServers(data.servers);
      setError(null);
    } catch (err) {
      console.error("Failed to load MCP servers:", err);
      setError((err as Error).message || "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const createServer = useCallback(
    async (input: McpServerInput): Promise<McpServer> => {
      const data = await postJson<{ server: McpServer }>("/api/mcp/servers", input);
      // Re-read rather than append: the list is the account's servers and the
      // instance's, and only the server knows where a new one lands.
      await loadServers();
      return data.server;
    },
    [loadServers],
  );

  const updateServer = useCallback(
    async (id: string, input: McpServerInput): Promise<McpServer> => {
      const data = await patchJson<{ server: McpServer }>(`/api/mcp/servers/${id}`, input);
      setServers((prev) => prev.map((server) => (server.id === id ? data.server : server)));
      return data.server;
    },
    [],
  );

  const deleteServer = useCallback(
    async (id: string): Promise<void> => {
      await deleteJson(`/api/mcp/servers/${id}`);
      // Removing the account's server of a shared name reveals the shared one.
      await loadServers();
    },
    [loadServers],
  );

  /**
   * Connect to a server and list its tools.
   *
   * `id` may be `new`, which tests unsaved values from the form. `token` is
   * omitted for an existing server that should use its stored token.
   */
  const testServer = useCallback(
    async (
      id: string,
      input: {
        transport: McpTransport;
        url?: string;
        token?: string;
        command?: string;
        cwd?: string;
      },
    ): Promise<McpTestResult> => {
      try {
        return await postJson<McpTestResult>(`/api/mcp/servers/${id}/test`, input);
      } catch (err) {
        // A failed test is an answer, not a crash: report it next to the form.
        return { success: false, error: (err as Error).message || "Connection failed" };
      }
    },
    [],
  );

  /** Begin an OAuth sign-in; the returned URL must be opened in a browser. */
  const startOAuth = useCallback(
    async (id: string): Promise<McpOAuthStart> => {
      const result = await postJson<McpOAuthStart>(`/api/mcp/servers/${id}/oauth/start`, {});
      // A completed sign-in changes the stored credential the list reports.
      if (result.status === "succeeded") await loadServers();
      return result;
    },
    [loadServers],
  );

  /** Poll a running OAuth sign-in. */
  const readOAuthStatus = useCallback(
    (id: string): Promise<McpOAuthStatus> =>
      fetchJson<McpOAuthStatus>(`/api/mcp/servers/${id}/oauth`),
    [],
  );

  /** Add the servers of a config pasted from another client. */
  const importServers = useCallback(
    async (config: string): Promise<ImportedMcpServerList> => {
      const data = await postJson<ImportedMcpServerList>("/api/mcp/servers/import", { config });
      await loadServers();
      return data;
    },
    [loadServers],
  );

  /** Forget a server's OAuth sign-in. */
  const signOutOAuth = useCallback(
    async (id: string): Promise<void> => {
      await deleteJson(`/api/mcp/servers/${id}/oauth`);
      await loadServers();
    },
    [loadServers],
  );

  return {
    servers,
    loading,
    actionLoading,
    setActionLoading,
    error,
    loadServers,
    createServer,
    updateServer,
    deleteServer,
    importServers,
    testServer,
    startOAuth,
    readOAuthStatus,
    signOutOAuth,
  };
}
