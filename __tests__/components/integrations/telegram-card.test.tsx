// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TelegramBox, TelegramLinkPanel } from "@/components/integrations/telegram-card";
import type {
  TelegramBotStatus,
  TelegramLink,
  TelegramLinkCode,
} from "@/hooks/use-telegram-integration";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const link: TelegramLink = {
  telegramUserId: "119075844",
  chatId: "119075844",
  displayName: "Test User",
  linkedAt: "2024-01-01T00:00:00.000Z",
};

const bot: TelegramBotStatus = {
  configured: true,
  enabled: true,
  username: "saale_bot",
  loginEnabled: true,
};

const linkCode: TelegramLinkCode = {
  code: "abcDEF123_-GHIJKL456_-mnopqr789_",
  deepLink: "https://t.me/saale_bot?start=abcDEF123_-GHIJKL456_-mnopqr789_",
  expiresAt: "2030-01-01T00:12:00.000Z",
  botUsername: "saale_bot",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderBox(overrides: Partial<Parameters<typeof TelegramBox>[0]> = {}) {
  const onUnlink = vi.fn();
  const onLink = vi.fn();

  render(
    <TelegramBox
      link={link}
      bot={bot}
      unlinking={false}
      onUnlink={onUnlink}
      onLink={onLink}
      {...overrides}
    />,
  );

  return { onUnlink, onLink };
}

function renderPanel(overrides: Partial<Parameters<typeof TelegramLinkPanel>[0]> = {}) {
  const onCreateCode = vi.fn();

  render(
    <TelegramLinkPanel
      bot={bot}
      linkCode={null}
      linking={false}
      linkError={null}
      linked={false}
      onCreateCode={onCreateCode}
      {...overrides}
    />,
  );

  return { onCreateCode };
}

/** Open the card's row menu and click an item by label. */
async function clickMenuItem(label: string) {
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(await screen.findByText(label));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TelegramBox", () => {
  it("shows which Telegram account is linked", () => {
    renderBox();

    expect(screen.getByText("Telegram")).toBeInTheDocument();
    expect(screen.getByText("@saale_bot")).toBeInTheDocument();
    expect(screen.getByText(/Test User · ID 119075844/)).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("still renders the raw id when the link has no cached name", () => {
    renderBox({ link: { ...link, displayName: null } });

    // The id is the identity; the name is only a cache of what Telegram told us.
    expect(screen.getByText("ID 119075844")).toBeInTheDocument();
  });

  it("offers a link button instead of a status when nothing is linked", () => {
    renderBox({ link: null });

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Link Telegram/ })).toBeInTheDocument();
    // No menu or account details while unlinked.
    expect(screen.queryByRole("button", { name: /Unlink/ })).not.toBeInTheDocument();
  });

  it("unlinks through the row menu", async () => {
    const { onUnlink } = renderBox();

    await clickMenuItem("Unlink");

    expect(onUnlink).toHaveBeenCalledTimes(1);
  });

  it("opens the link dialog for relinking through the row menu", async () => {
    const { onLink, onUnlink } = renderBox();

    await clickMenuItem("Link a different account");

    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onUnlink).not.toHaveBeenCalled();
  });
});

describe("TelegramLinkPanel", () => {
  it("tells the user when the instance has no bot, and offers no code", () => {
    const { onCreateCode } = renderPanel({
      bot: { configured: false, enabled: false, username: null, loginEnabled: false },
    });

    expect(screen.getByText(/No Telegram bot is set up on this instance/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Get link code/ })).not.toBeInTheDocument();
    expect(onCreateCode).not.toHaveBeenCalled();
  });

  it("tells the user when the bot is switched off, and offers no code", () => {
    renderPanel({ bot: { ...bot, enabled: false } });

    expect(screen.getByText(/switched off/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Get link code/ })).not.toBeInTheDocument();
  });

  it("asks for a code rather than minting one unprompted", () => {
    const { onCreateCode } = renderPanel();

    // Minting on render would create codes nobody asked for (and race itself
    // under React's double-invoked effects).
    expect(onCreateCode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Get link code/ }));

    expect(onCreateCode).toHaveBeenCalledTimes(1);
  });

  it("warns that relinking replaces the current account", () => {
    renderPanel({ linked: true });

    expect(screen.getByText(/replaces the one currently linked/)).toBeInTheDocument();
  });

  it("shows the bare code, the bot, and the deep link", () => {
    renderPanel({ linkCode });

    expect(screen.getByText(linkCode.code)).toBeInTheDocument();
    // The instruction is to send the code itself  /start is Telegram's own
    // first message, not something the user has to type.
    expect(screen.queryByText(new RegExp(`/start ${linkCode.code}`))).not.toBeInTheDocument();

    const anchor = screen.getByRole("link", { name: /Open Telegram/ });
    expect(anchor).toHaveAttribute("href", linkCode.deepLink);
    // Noopener: the deep link leaves the app.
    expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("surfaces a linking error", () => {
    renderPanel({ linkError: "The Telegram bot is switched off. Ask an admin to enable it." });

    expect(screen.getByText(/switched off. Ask an admin/)).toBeInTheDocument();
  });

  it("shows a creating state instead of a second code button", () => {
    renderPanel({ linking: true });

    expect(screen.getByRole("button", { name: /Creating/ })).toBeDisabled();
  });
});
