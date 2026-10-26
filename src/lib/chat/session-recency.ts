/**
 * Chats idle for longer than this fold into the sidebar's "Older chats" card.
 * Anything within the window stays in the top-level list.
 */
export const OLD_CHAT_INACTIVITY_DAYS = 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SessionActivity {
  lastActivityAt?: string | null;
  updatedAt: string;
}

export interface SessionPin {
  pinned?: boolean | null;
}

/**
 * Lifts the pinned chats out of the list. They sit at the top of the sidebar,
 * so neither age nor a collapsed card can bury them.
 */
export function splitPinnedSessions<T extends SessionPin>(
  sessions: T[],
): { pinned: T[]; unpinned: T[] } {
  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const session of sessions) {
    if (session.pinned) pinned.push(session);
    else unpinned.push(session);
  }

  return { pinned, unpinned };
}

/**
 * Epoch ms of a chat's last real activity. `lastActivityAt` is the source of
 * truth (messages sent, title edits); `updatedAt` only covers legacy rows.
 */
export function lastActivityTimestamp(session: SessionActivity): number {
  const value = session.lastActivityAt ?? session.updatedAt;
  const time = new Date(value).getTime();
  // An unparseable timestamp must not push a chat out of sight.
  return Number.isNaN(time) ? Infinity : time;
}

/**
 * Splits chats into recently used ones and the older ones that belong behind
 * the folded card. Idle time is measured from `now`.
 */
export function splitSessionsByActivity<T extends SessionActivity>(
  sessions: T[],
  now: number = Date.now(),
): { recent: T[]; older: T[] } {
  const cutoff = now - OLD_CHAT_INACTIVITY_DAYS * MS_PER_DAY;
  const recent: T[] = [];
  const older: T[] = [];

  for (const session of sessions) {
    if (lastActivityTimestamp(session) >= cutoff) {
      recent.push(session);
    } else {
      older.push(session);
    }
  }

  return { recent, older };
}
