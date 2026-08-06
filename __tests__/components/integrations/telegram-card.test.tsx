// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TelegramCard } from "@/components/integrations/telegram-card";
import type { TelegramAccount, WhitelistEntry } from "@/hooks/use-telegram-integration";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const account: TelegramAccount = {
  id: "acc-1",
  enabled: true,
  botId: "123456",
  botUsername: "saale_bot",
  whitelistCount: 1,
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
      {...overrides}
    />,
  );

  return { onOpenWhitelist, onToggleEnabled, onDelete, onAddUser, onRemoveUser };
}

/** Open the "Manage Whitelist" dialog via the card's dropdown menu. */
async function openWhitelistDialog() {
  const moreButton = screen.getByRole("button");
  fireEvent.click(moreButton);

  const manageItem = await screen.findByText("Manage Whitelist");
  fireEvent.click(manageItem);
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
