/**
 * `@handle` parsing and resolution.
 *
 * The room has one addressing syntax: `@name` wakes a member, `@all` wakes
 * everyone and `@user` addresses the human. Members address each other through
 * it, and a message's mentions decide who runs next. so this module is the one
 * place the syntax is read, shared by the tools, the orchestrator and the UI.
 *
 * Pure. no database or Node-only imports, so the room can resolve handles
 * client-side for the same preview the server would compute.
 */

/** The handle that addresses the human. */
export const USER_HANDLE = "user";
/** The handle that addresses every enabled member. */
export const ALL_HANDLE = "all";
/** Handles no member may be named: they address the room, not a member. */
export const RESERVED_HANDLES = [USER_HANDLE, ALL_HANDLE, "system"] as const;

/** A member's display name is also its handle. */
export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * `@…` at a boundary, matching the longest run of handle characters.
 *
 * The leading `@` is captured separately so a match can be rejected when it is
 * really an email address (`you@example.com`). a `@` preceded by a word
 * character is part of a word, not an address to a member.
 */
const MENTION_PATTERN = /(@)([A-Za-z0-9_-]+)/g;

/** Characters that make a preceding `@` part of a word rather than a mention. */
function isHandleCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

export function normalizeMemberName(name: string): string {
  return name.trim();
}

/**
 * Whether a name can be used as a member handle.
 *
 * Reserved handles are refused rather than silently shadowed: a member named
 * `user` would make `@user` mean two different things depending on the order of
 * resolution.
 */
export function isValidMemberName(name: string): boolean {
  const trimmed = normalizeMemberName(name);
  if (!MEMBER_NAME_PATTERN.test(trimmed) || trimmed.length > 50) return false;
  return !RESERVED_HANDLES.some((reserved) => reserved === trimmed.toLowerCase());
}

/**
 * Every handle a message addresses, lowercased, in first-seen order.
 *
 * A trailing separator is dropped (`@alice- ok` addresses `alice`), and a match
 * inside a word is not a mention (`you@example.com` addresses nobody).
 */
export function parseMentions(content: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const atIndex = match.index ?? 0;
    if (isHandleCharacter(content[atIndex - 1])) continue;

    const raw = match[2] ?? "";
    const handle = raw.replace(/[_-]+$/, "").toLowerCase();
    if (!handle || seen.has(handle)) continue;

    seen.add(handle);
    handles.push(handle);
  }

  return handles;
}

/** A member as mention resolution sees it. */
export interface MentionTarget {
  id: string;
  name: string;
}

export interface MentionResolution {
  /** Member ids addressed, in the order they were addressed (deduped). */
  memberIds: string[];
  /** The message addresses the human (`@user`). */
  addressesUser: boolean;
  /** Handles naming no member and no reserved handle. */
  unknown: string[];
}

/**
 * Resolve a message's handles against the council's members.
 *
 * Unknown handles are reported instead of dropped: a member that meant to wake
 * a colleague it misnamed has silently reached nobody, and the tool turns this
 * list into an error that names the valid handles.
 */
export function resolveMentions(
  content: string,
  members: readonly MentionTarget[],
): MentionResolution {
  const byHandle = new Map<string, string>();
  for (const member of members) {
    byHandle.set(normalizeMemberName(member.name).toLowerCase(), member.id);
  }

  const memberIds: string[] = [];
  const unknown: string[] = [];
  let addressesUser = false;

  for (const handle of parseMentions(content)) {
    if (handle === USER_HANDLE) {
      addressesUser = true;
      continue;
    }
    // `@all` and `@system` address the room, not one member: the orchestrator
    // wakes every member and the system notices are not addressable.
    if (handle === ALL_HANDLE || handle === "system") continue;

    const id = byHandle.get(handle);
    if (id) {
      if (!memberIds.includes(id)) memberIds.push(id);
      continue;
    }
    unknown.push(handle);
  }

  return { memberIds, addressesUser, unknown };
}

/** Whether a message addresses everyone (`@all`). */
export function addressesEveryone(content: string): boolean {
  return parseMentions(content).includes(ALL_HANDLE);
}

/** The handles a member may address, for tool errors and prompts. */
export function mentionHelp(members: readonly MentionTarget[]): string {
  return [...members.map((member) => `@${member.name}`), `@${USER_HANDLE}`, `@${ALL_HANDLE}`].join(
    ", ",
  );
}
