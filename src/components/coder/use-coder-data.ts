"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/http";

/** A project as the list shows it. */
export interface CoderProjectSummary {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  defaultBranch: string;
  worktreeCount: number;
  chatCount: number;
  lastActivityAt: string | null;
}

/** One of a project's chats. */
export interface CoderProjectChat {
  id: string;
  title: string;
  lastActivityAt: string;
  isGenerating: boolean;
  worktree: { path: string; branch: string; status: string } | null;
}

export interface CoderProjectDetail {
  project: {
    id: string;
    name: string;
    slug: string;
    repoPath: string;
    defaultBranch: string;
    originUrl: string | null;
  };
  chats: CoderProjectChat[];
}

/** One changed path in a chat's worktree. */
export interface CoderChange {
  path: string;
  originalPath: string | null;
  added: number | null;
  deleted: number | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface CoderCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  author: string;
}

/** One stage of building a chat's workspace, as the server reports it. */
export interface CoderProvisioning {
  step: "worktree" | "setup";
  startedAt: string;
}

/** `GET /api/coder/sessions/:id/status`. */
export interface CoderSessionState {
  worktree: { path: string; branch: string; baseSha: string } | null;
  project: { id: string; name: string; slug: string } | null;
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: CoderChange[];
  commits: CoderCommit[];
  scripts: { name: string; command: string; runCommand: string }[];
  /** Set while the chat is building its workspace (first message). */
  provisioning: CoderProvisioning | null;
}

/** Load one thing, with the reload the panels need after a run finishes. */
function useLoad<T>(url: string | null): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!url) return;
    const ticket = ++latest.current;
    setLoading(true);
    fetchJson<T>(url)
      .then((body) => {
        if (ticket !== latest.current) return;
        setData(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ticket !== latest.current) return;
        console.error(`Failed to load ${url}:`, err);
        setError(err instanceof Error ? err.message : "Could not load this");
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}

export function useProjects() {
  const { data, loading, error, reload } = useLoad<{ projects: CoderProjectSummary[] }>(
    "/api/coder/projects",
  );
  return { projects: data?.projects ?? [], loading, error, reload };
}

export function useProject(projectId: string | null) {
  const { data, loading, error, reload } = useLoad<CoderProjectDetail>(
    projectId ? `/api/coder/projects/${encodeURIComponent(projectId)}` : null,
  );
  return { project: data?.project ?? null, chats: data?.chats ?? [], loading, error, reload };
}

/**
 * A chat's worktree state.
 *
 * `refreshKey` is the caller's signal that something may have changed (a run
 * finished, the user pressed refresh), so the panel follows the agent instead
 * of only loading once.
 */
export function useSessionState(sessionId: string | null, refreshKey: number) {
  const [state, setState] = useState<CoderSessionState | null>(null);
  const [loading, setLoading] = useState(sessionId !== null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setState(null);
      setLoading(false);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    fetchJson<CoderSessionState>(`/api/coder/sessions/${encodeURIComponent(sessionId)}/status`)
      .then((body) => {
        if (ticket !== latest.current) return;
        setState(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ticket !== latest.current) return;
        console.error(`Failed to load worktree state for ${sessionId}:`, err);
        setError(err instanceof Error ? err.message : "Could not read the worktree");
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [sessionId, refreshKey]);

  return { state, loading, error };
}

/** How often a waiting chat asks whether its workspace is still being built. */
const PROVISIONING_POLL_MS = 1_500;

/**
 * Whether this chat is building its workspace right now.
 *
 * Polled, not streamed: the SSE connection that prompts the first message is
 * the very request that builds the workspace, so it answers nothing until the
 * build is over. There is no event to wait for.
 *
 * `waiting` is the caller's window (a reply is owed and none has started), and
 * it is what bounds the polling: a chat that has answered one message keeps its
 * workspace, so nobody goes on asking.
 */
export function useProvisioning(sessionId: string | null, waiting: boolean) {
  const [state, setState] = useState<CoderProvisioning | null>(null);

  useEffect(() => {
    setState(null);
    if (!sessionId || !waiting) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seen = false;

    const stop = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };

    const tick = async () => {
      try {
        const body = await fetchJson<{ provisioning: CoderProvisioning | null }>(
          `/api/coder/sessions/${encodeURIComponent(sessionId)}/provisioning`,
        );
        if (cancelled) return;
        if (body.provisioning) {
          seen = true;
          setState(body.provisioning);
        } else {
          setState(null);
          // One record seen and then gone means the build finished: asking for
          // the rest of the run would only ever answer null again.
          if (seen) {
            stop();
            return;
          }
        }
      } catch (err) {
        console.error(`Failed to read the provisioning step for ${sessionId}:`, err);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), PROVISIONING_POLL_MS);
    };

    void tick();
    return stop;
  }, [sessionId, waiting]);

  return state;
}
