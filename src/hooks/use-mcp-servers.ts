"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import type { McpToolPolicy } from "@/lib/mcp/shared";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  description: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  /** Whether a bearer token is stored. The token itself is never sent to the client. */
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input for adding or updating a server. `token: ""` clears a stored token. */
export interface McpServerInput {
  name?: string;
  url?: string;
  description?: string;
  token?: string;
  toolPolicy?: McpToolPolicy;
  enabled?: boolean;
}

/** Result of a connection test: the server identity and the tools it offers. */
export interface McpTestResult {
  success: boolean;
  serverName?: string | null;
  serverVersion?: string | null;
  tools?: { name: string; description: string | null }[];
  error?: string;
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

  const createServer = useCallback(async (input: McpServerInput): Promise<McpServer> => {
    const data = await postJson<{ server: McpServer }>("/api/mcp/servers", input);
    setServers((prev) => [...prev, data.server]);
    return data.server;
  }, []);

  const updateServer = useCallback(
    async (id: string, input: McpServerInput): Promise<McpServer> => {
      const data = await patchJson<{ server: McpServer }>(`/api/mcp/servers/${id}`, input);
      setServers((prev) => prev.map((server) => (server.id === id ? data.server : server)));
      return data.server;
    },
    [],
  );

  const deleteServer = useCallback(async (id: string): Promise<void> => {
    await deleteJson(`/api/mcp/servers/${id}`);
    setServers((prev) => prev.filter((server) => server.id !== id));
  }, []);

  /**
   * Connect to a server and list its tools.
   *
   * `id` may be `new`, which tests unsaved values from the form. `token` is
   * omitted for an existing server that should use its stored token.
   */
  const testServer = useCallback(
    async (id: string, input: { url: string; token?: string }): Promise<McpTestResult> => {
      try {
        return await postJson<McpTestResult>(`/api/mcp/servers/${id}/test`, input);
      } catch (err) {
        // A failed test is an answer, not a crash: report it next to the form.
        return { success: false, error: (err as Error).message || "Connection failed" };
      }
    },
    [],
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
    testServer,
  };
}
