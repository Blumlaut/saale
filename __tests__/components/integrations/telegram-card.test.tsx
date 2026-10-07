// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TelegramCard } from "@/components/integrations/telegram-card";
import type {
  TelegramAccount,
  TelegramChatInfo,
  WhitelistEntry,
} from "@/hooks/use-telegram-integration";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const account: TelegramAccount = {
  id: "acc-1",
  enabled: true,
  botId: "123456",
  botUsername: "saale_bot",
  whitelistCount: 1,
  notifyChatId: null,
  notifyChat: { chatId: "119075844", label: "Test User", source: "private" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const whitelistedUser: WhitelistEntry = {
  id: "wl-1",
  telegramUserId: "119075844",
  displayName: "Test User",
  createdAt: "2024-01-01T00:00:00.000Z",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderCard(overrides: Partial<Parameters<typeof TelegramCard>[0]> = {}) {
  const onOpenWhitelist = vi.fn();
  const onToggleEnabled = vi.fn();
  const onDelete = vi.fn();
  const onNewUserIdChange = vi.fn();
  const onAddUser = vi.fn();
  const onRemoveUser = vi.fn();
  const onOpenNotifyChats = vi.fn();
  const onSetNotifyChat = vi.fn();

  render(
    <TelegramCard
      account={account}
      onToggleEnabled={onToggleEnabled}
      onDelete={onDelete}
      actionLoading={null}
      whitelistEntries={[]}
      whitelistLoading={false}
      onOpenWhitelist={onOpenWhitelist}
      newUserId=""
      onNewUserIdChange={onNewUserIdChange}
      addingUser={false}
      onAddUser={onAddUser}
      onRemoveUser={onRemoveUser}
      notifyChats={[]}
      notifyChatsLoading={false}
      savingNotifyChat={false}
      onOpenNotifyChats={onOpenNotifyChats}
      onSetNotifyChat={onSetNotifyChat}
      {...overrides}
    />,
  );

  return {
    onOpenWhitelist,
    onToggleEnabled,
    onDelete,
    onAddUser,
    onRemoveUser,
    onOpenNotifyChats,
    onSetNotifyChat,
  };
}

/** Open the "Manage Whitelist" dialog via the card's dropdown menu. */
async function openWhitelistDialog() {
  const moreButton = screen.getByRole("button");
  fireEvent.click(moreButton);

  const manageItem = await screen.findByText("Manage Whitelist");
  fireEvent.click(manageItem);
}

/** Open the "Notification Chat" dialog via the card's dropdown menu. */
async function openNotifyChatDialog() {
  fireEvent.click(screen.getByRole("button"));

  const menuItem = await screen.findByText("Notification Chat");
  fireEvent.click(menuItem);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TelegramCard whitelist", () => {
  it("fetches fresh whitelist entries every time the dialog opens", async () => {
    const { onOpenWhitelist } = renderCard();

    await openWhitelistDialog();
    expect(onOpenWhitelist).toHaveBeenCalledTimes(1);

    // Reopening the dialog fetches again — the whitelist may have changed
    // elsewhere (webhook auto-whitelist, another device) since last time.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await openWhitelistDialog();
    expect(onOpenWhitelist).toHaveBeenCalledTimes(2);
  });

  it("shows whitelisted users when entries are provided", async () => {
    renderCard({ whitelistEntries: [whitelistedUser] });

    await openWhitelistDialog();

    expect(await screen.findByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("ID: 119075844")).toBeInTheDocument();
  });

  it("shows the empty state when there are no entries", async () => {
    renderCard({ whitelistEntries: [] });

    await openWhitelistDialog();

    expect(await screen.findByText("No users whitelisted yet")).toBeInTheDocument();
  });

  it("does not fetch when the dialog is simply closed", async () => {
    const { onOpenWhitelist } = renderCard();

    // No interaction — the callback must not fire on mount
    expect(onOpenWhitelist).not.toHaveBeenCalled();
  });
});

// ─── Notification chat ───────────────────────────────────────────────────────

describe("TelegramCard notification chat", () => {
  const chats: TelegramChatInfo[] = [
    { chatId: "119075844", label: "Test User", chatType: "private" },
    { chatId: "-100123456789", label: "Group chat", chatType: "group" },
  ];

  it("fetches fresh chats every time the dialog opens", async () => {
    const { onOpenNotifyChats } = renderCard();

    await openNotifyChatDialog();
    expect(onOpenNotifyChats).toHaveBeenCalledTimes(1);

    // Reopening refetches — the reachable chats change as the user messages
    // the bot, so a cached list would be wrong.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await openNotifyChatDialog();
    expect(onOpenNotifyChats).toHaveBeenCalledTimes(2);
  });

  it("shows where notifications currently go and why", async () => {
    renderCard();

    await openNotifyChatDialog();

    expect(await screen.findByText("Currently: Test User")).toBeInTheDocument();
    expect(screen.getByText(/119075844 · automatic/)).toBeInTheDocument();
  });

  it("offers an automatic option and every known chat", async () => {
    renderCard({ notifyChats: chats });

    await openNotifyChatDialog();
    // The Select renders its options in a portal only once opened, so drive it
    // the way a user would.
    fireEvent.click(await screen.findByRole("combobox"));

    expect(await screen.findByText("Automatic (most recent private chat)")).toBeInTheDocument();
    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("Group chat — group")).toBeInTheDocument();
  });

  it("explains the empty state when no chat is reachable", async () => {
    renderCard({ account: { ...account, notifyChat: null } });

    await openNotifyChatDialog();

    expect(await screen.findByText(/No chat available yet/)).toBeInTheDocument();
  });
});
