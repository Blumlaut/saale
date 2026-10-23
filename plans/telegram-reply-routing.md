# Telegram: reply routing, then group targets

Two phases, in this order. Phase 1 makes an incoming Telegram message continue the
chat that sent it. Phase 2 makes a Telegram group a destination for autonomous
sends. Phase 2 wants Phase 1, because a group alert should be answerable in the
chat that produced it.

**Status:** Phase 1 is implemented. Phase 2 is not started.

## Why

Today a Telegram conversation is its own chat: `upsertTelegramSession`
(`src/lib/telegram/processor.ts:988`) creates one `ChatSession` per link and
reuses it until `isSessionExpired` (`:964`) drops it. A message the agent sends
into Telegram from another context is replayed into that same chat by
`recordTelegramJobOutput` (`src/lib/telegram/outbound.ts`), so the private agent
believes it said something to the user privately.

The cost is context: the user replies to an alert and the agent has no memory of
the run that produced it, and the source chat never sees the exchange at all.

Phase 1 replaces that with session routing. Phase 2 adds groups.

---

# Phase 1 — Route a Telegram message into the chat that sent it

## Resolution rule

1. The message is a Telegram reply (`message.reply_to_message.message_id`) and a
   mapping row exists for it → the message continues **that** session.
2. No reply, or no mapping → the session that last sent a Telegram message.
3. Neither → the link's home thread, i.e. today's dedicated chat, which stays as
   the fallback so a first message works and `TelegramLink.sessionId` keeps its
   meaning.

The quoted message still reaches the agent through `replyToQuoted`
(`processor.ts` → `buildQuotedContext`), so when the mapping is missing (a task
reminder, a job alert with no source chat) the reply lands in the home thread and
still carries what it is answering.

## Schema

New model plus one column, added through `.pi/skills/database-migrations/SKILL.md`.

```prisma
/// One message Saale sent to Telegram, so a reply can find the chat that sent it.
model TelegramOutboundMessage {
  id         String    @id @default(cuid())
  userId     String
  botId      String
  chatId     BigInt
  messageId  BigInt
  /// The chat that produced the message. Null for deliveries with no source chat.
  sessionId   String?
  /// Set once groups are targets (Phase 2).
  groupChatId BigInt?
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([chatId, messageId])
  @@index([userId, createdAt])
  @@map("TelegramOutboundMessage")
}
```

`TelegramLink` gains `lastOutboundSessionId String?`.

A long message splits into several Telegram messages (`sendTelegramMessage`
returns `number[]`, `src/lib/telegram/client.ts:176`). Every id in that array gets
a row pointing at the same session, so replying to any chunk lands in the right
chat.

Rows are pruned on a TTL (`TELEGRAM_OUTBOUND_TTL_DAYS`, default 90) from a
periodic worker scheduler next to `registerOrphanCleanup`
(`src/lib/queue/worker.ts:179`).

## Delivery carries its source

`deliverTelegramMessage` and `sendTelegramToUser` (`src/lib/telegram/notify.ts`)
gain `sourceSessionId?: string`. Inside the same call they write the mapping rows
and bump `lastOutboundSessionId`. `recordTelegramJobOutput` stops being the thing
that decides where outbound text is recorded: the source session is now known, so
it writes the assistant message into that session, and only falls back to the
home thread when there is no source.

Callers to update:

- `src/lib/pi/tools/telegram-tools.ts` — `createTelegramTools(userId, sessionId)`.
  The registry already passes both (`ToolFactory` in `src/lib/pi/tool-registry.ts`),
  so this is a one-line change to the `telegram` entry.
- `src/lib/agent-jobs/output.ts` — a job run has no chat session; pass nothing.
- `src/lib/queue/jobs/task-reminders.ts` — nothing.

## Processing an incoming message

`processTelegramMessage` gains a resolution step before any work:

- Resolve the target session from the rule above (`resolveTelegramTarget`, new,
  in `src/lib/telegram/`).
- **Home thread** → today's path, unchanged: the processor owns session
  creation, expiry, persistence.
- **An existing chat** → drive that chat through the same primitives the web
  stream route and `respondInChat` use (`ensureChatAgent`, `beginChatRun`,
  `dispatchChatRun` in `src/lib/chat/agent-run.ts`). That is what makes a
  Telegram message appear live in an open browser tab: `beginChatRun` publishes
  `messages_changed` on the session bus, which the stream route forwards.

What stays Telegram-specific and follows the message into a routed session:

- the typing indicator, and the reply card/approval rendering — the approval bus
  is subscribed per session (`subscribeSessionEvents(sessionId, …)`), so cards for
  a web chat can be answered from Telegram by the linked user, and the presser
  check in the webhook still applies;
- supersession (`session-registry.ts`) — keyed by `${userId}:${telegramChatId}`,
  which keeps working for the chat, but a routed run is now one run in a session
  the web can also prompt;
- file uploads, which land in the resolved session's workspace.

## Concurrency

A chat can now be prompted from the browser and from Telegram. `respondInChat`
already sets the convention (`src/lib/chat/respond-in-chat.ts`): claim
`entry.promptInFlight`, refuse a busy chat, never queue. Follow it, with a short
Telegram reply ("That chat is busy, try again in a moment") instead of an error
the user never sees. The existing latest-message-wins supersession stays for
messages that a *later Telegram message* supersedes.

## Commands

A command executed from Telegram must act on the resolved session, so
`executeCommand`'s Telegram context carries `sessionId`:

- `/compact` (`src/lib/commands/handlers/compact.ts`) calls `compactChatSession`
  and loses `compactTelegramSession` for routed messages; the home thread keeps
  the existing behaviour.
- `/stop` acts on the resolved session through the same abort the stop route
  uses.

## Tests

- Resolution: reply→mapped, no reply→last, neither→home, mapped id for another
  user is ignored.
- Chunked send writes one row per message id, all pointing at the source.
- A busy chat is refused and the message is not stored.
- A routed message publishes `messages_changed` and persists both messages.
- `/compact` from Telegram compacts the resolved chat.
- Prune deletes rows past the TTL and nothing else.

---

# Phase 2 — A group as a send target

Send-only. The bot never answers in a group; it only posts. Conversation in
groups is a separate decision (see Open items).

## Registration

Telegram tells us who added the bot: `message.new_chat_members` arrives as a
service message, and bots receive **all** service messages regardless of privacy
mode. The adder is `message.from`.

The bot stays in a group only when a Saale user put it there. Anything else is
refused: post one short line naming what is needed, then `leaveChat`.

On `new_chat_members` containing the bot:

| Adder | Group row | Action |
|---|---|---|
| linked | none | create it, `getChat` for title/kind/memberCount, confirm in the private chat |
| linked, the owner | exists, enabled | nothing, the bot is already where it belongs |
| linked, the owner | exists, disabled | re-enable |
| linked, not the owner | exists | refuse and leave, ownership never moves silently |
| unlinked | any | refuse and leave |
| not identifiable (`from` absent, added by a bot or through a link) | any | refuse and leave |

The refusal goes out before the bot leaves, and names only the Settings page, so
it says nothing about who owns the group.

The security-critical branch in
`src/app/api/integrations/telegram/webhook/route.ts` keeps refusing group
*content*; only membership service messages are read.

## Schema

```prisma
/// A Telegram group the bot may post into. One owner per group.
model TelegramChat {
  id           String    @id @default(cuid())
  botId        String
  ownerUserId  String
  chatId       BigInt    @unique
  title        String?
  kind         String    // "group" | "supergroup"
  memberCount  Int?
  enabled      Boolean   @default(true)
  /// Last successful getChat. drives the title/count refresh.
  syncedAt     DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  owner        User      @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)

  @@index([ownerUserId])
  @@map("TelegramChat")
}
```

`chatId` is globally unique, so a group has exactly one owner and a refused
re-add is enforceable. Deleting the user frees the group.

## Service messages from known groups

Accept from `TelegramChat` rows only, and ignore everything else from a group:

- `new_chat_title` → update `title`.
- `migrate_to_chat_id` → a group upgraded to a supergroup changes its id. Rewrite
  the row, and `updateMany` any `AgentDefinition.outputChannelId` /
  `AgentRun.outputChannelId` for that owner that still names the old id.
- the bot's own `left_chat_member` → `enabled = false`, so the UI shows it is gone
  instead of a job failing delivery forever.

Titles also refresh through `getChat` when `syncedAt` is older than a day, lazily,
inside the list call. The API has no member list for bots: `getChatMemberCount`
gives a number, `getChatAdministrators` gives admins only, and `getChatMember` is
guaranteed only for admin bots. Expose `memberCount`, skip members.

## Delivery

- `telegram_send` gains an optional `target`. It is the Telegram chat id
  (`-100…`), matching the documented meaning of `AgentDefinition.outputChannelId`.
  Values are validated against the caller's `TelegramChat` rows; an unknown target
  throws with the available titles listed, so the model corrects in one turn.
- `telegram_chats` (new tool, category `telegram`, `defaultPolicy: "allow"`, no
  arguments) lists the private link and the group rows: chat id, title, kind,
  member count, enabled. Nothing about chats goes into a description or the system
  prompt — pooled sessions bake those and would go stale.
- `buildAgentOutputHandler` (`src/lib/agent-jobs/output.ts`) honours
  `outputChannelId` when set, resolving it through the same validator.
- A group send writes a one-line breadcrumb into the source session
  (`[sent to "CVEs"] <first line>`) so the chat that produced it has context, and
  a mapping row so a reply can be routed once Phase 2 grows replies.

## UI

Integrations tab lists the groups with title, member count and a remove action,
next to the linked private account. Adding a group happens in Telegram; the UI
only shows and removes. Every new overlay registers in
`e2e/modal-scenarios.ts`.

## Tests

- `new_chat_members` with a linked adder creates the row, and with an unlinked
  adder replies then leaves without storing anything.
- A re-add by another linked user neither reassigns the row nor keeps the bot in
  the chat, and a disabled row is re-enabled only by its owner.
- `telegram_chats` lists private plus groups and is auto-approved.
- `telegram_send` with an unregistered target throws and names the valid ones.
- `outputChannelId` resolves to the right group, and a kicked bot surfaces a
  delivery error instead of a silent success.
- `migrate_to_chat_id` rewrites the row and the stored `outputChannelId`.
- The TTL refresh keeps the cached title when `getChat` fails.

---

# Verification

Per phase: `npm run lint:fix`, `npm run typecheck`, targeted `npx vitest run`,
then `npm run check` once. Migration through the database-migrations skill, never
`prisma db push` against live data. A local build needs
`NODE_ENV=production npm run build`.

---

# Open items

- **Group conversation.** The bot answering mentions in a group is a separate
  feature: owner-only senders plus a `[Name (@handle)]` prefix is the guard, but
  every member reads the reply and approval cards, and any member's text is a
  prompt-injection surface with an audience. Not part of this plan.
- **A chat thread per agent job.** A reply to a job alert currently lands in the
  home thread with the quoted text. If job threads exist later, the mapping row
  points at them with no further change here.
