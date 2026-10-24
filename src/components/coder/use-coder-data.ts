"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/http";
import { CHAT_RENAMED_EVENT, CHAT_SESSIONS_DELETED_EVENT } from "@/lib/chat/session-events";

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

/** One path a commit touched, as the commit-diff endpoint reports it. */
export interface CommitDiffFile {
  path: string;
  originalPath: string | null;
  /** A, M, D, T, R or C. */
  status: string;
  added: number | null;
  deleted: number | null;
}

/** One path's two sides at a commit, for the diff editor. */
export interface CommitDiffFileContent {
  path: string;
  /** True when git reports the path as binary, or a side is too large. */
  binary: boolean;
  original: string | null;
  modified: string | null;
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
  /** Set when a build ran the setup script and it failed. */
  setupFailure: CoderSetupFailure | null;
}

/** A setup script that failed while the chat's worktree was being built. */
export interface CoderSetupFailure {
  exitCode: number | null;
  output: string;
  failedAt: string;
}

/** How often an open coder list re-reads itself while the tab is visible. */
const LIST_POLL_MS = 20_000;

/**
 * A re-read signal for a list that goes stale while it stays open.
 *
 * A title the server assigns (the first message names a new chat), a chat
 * deleted from the other list, a tab the user comes back to, and a slow poll
 * all land here. The poll is the only way a chat started on another device can
 * appear, and it is what keeps `isGenerating` honest on chats this panel is not
 * streaming.
 *
 * `key` is folded into the result, so passing the open chat's id refetches the
 * list it belongs in: the chat the header just created shows up in the panel
 * that sent the user there.
 */
export function useListRefresh(key: string | null = null): string {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const onFocus = () => bump();
    // A hidden tab does not need the poll, but the focus listener above means
    // coming back to it is enough to catch up.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, LIST_POLL_MS);

    window.addEventListener(CHAT_RENAMED_EVENT, bump);
    window.addEventListener(CHAT_SESSIONS_DELETED_EVENT, bump);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener(CHAT_RENAMED_EVENT, bump);
      window.removeEventListener(CHAT_SESSIONS_DELETED_EVENT, bump);
      window.removeEventListener("focus", onFocus);
    };
  }, [bump]);

  return `${key ?? ""}:${tick}`;
}

/**
 * Load one thing, with the reload the panels need after a run finishes.
 *
 * `refreshKey` re-reads without unmounting, and a re-read never blanks what is
 * already on screen: only the first read of a URL counts as loading.
 */
function useLoad<T>(
  url: string | null,
  refreshKey: string | number = 0,
): {
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
  const loadedUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) return;
    const ticket = ++latest.current;
    setLoading(loadedUrl.current !== url);
    fetchJson<T>(url)
      .then((body) => {
        if (ticket !== latest.current) return;
        loadedUrl.current = url;
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
  }, [url, refreshKey, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}

export function useProjects() {
  const refreshKey = useListRefresh();
  const { data, loading, error, reload } = useLoad<{ projects: CoderProjectSummary[] }>(
    "/api/coder/projects",
    refreshKey,
  );
  return { projects: data?.projects ?? [], loading, error, reload };
}

/**
 * One project and its chats.
 *
 * `activeSessionId` is not just for highlighting: opening a chat refetches the
 * list, so the chat that was started from this panel is in it.
 */
export function useProject(projectId: string | null, activeSessionId: string | null = null) {
  const refreshKey = useListRefresh(activeSessionId);
  const { data, loading, error, reload } = useLoad<CoderProjectDetail>(
    projectId ? `/api/coder/projects/${encodeURIComponent(projectId)}` : null,
    refreshKey,
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
