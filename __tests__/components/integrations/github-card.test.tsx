// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GitHubBox, GitHubConnectDialog } from "@/components/integrations/github-card";
import type { GitHubAccount } from "@/hooks/use-github-integration";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const account: GitHubAccount = {
  id: "1",
  enabled: true,
  username: "test-operator",
  avatarUrl: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderBox(overrides: Partial<Parameters<typeof GitHubBox>[0]> = {}) {
  const onToggleEnabled = vi.fn();
  const onDelete = vi.fn();
  const onConnect = vi.fn();

  render(
    <GitHubBox
      account={account}
      onToggleEnabled={onToggleEnabled}
      onDelete={onDelete}
      onConnect={onConnect}
      actionLoading={null}
      {...overrides}
    />,
  );

  return { onToggleEnabled, onDelete, onConnect };
}

function renderDialog(overrides: Partial<Parameters<typeof GitHubConnectDialog>[0]> = {}) {
  const onTokenChange = vi.fn();
  const onSave = vi.fn();
  const onClosed = vi.fn();
  const onOpenChange = vi.fn();

  render(
    <GitHubConnectDialog
      open
      onOpenChange={onOpenChange}
      token=""
      onTokenChange={onTokenChange}
      error={null}
      success={false}
      saving={false}
      onSave={onSave}
      onClosed={onClosed}
      {...overrides}
    />,
  );

  return { onTokenChange, onSave, onClosed, onOpenChange };
}

/** Open the box's row menu and click an item by label. */
async function clickMenuItem(label: string) {
  fireEvent.click(screen.getByRole("button"));
  fireEvent.click(await screen.findByText(label));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GitHubBox", () => {
  it("shows the connected account with its username", () => {
    renderBox();

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("test-operator")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/^Added /)).toBeInTheDocument();
  });

  it("flags a disabled account without changing the connection state", () => {
    renderBox({ account: { ...account, enabled: false } });

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("offers a connect button instead of controls when nothing is connected", () => {
    renderBox({ account: null });

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Connect GitHub/ });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("test-operator")).not.toBeInTheDocument();
  });

  it("removes the account through the row menu", async () => {
    const { onDelete } = renderBox();

    await clickMenuItem("Disconnect");

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubConnectDialog", () => {
  it("keeps the connect button disabled without a token", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("accepts a token and submits it, including on Enter", () => {
    const { onTokenChange, onSave } = renderDialog();

    const input = screen.getByPlaceholderText(/ghp_/);
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    expect(onTokenChange).toHaveBeenCalledWith("ghp_test123");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("surfaces the token error and the success message", () => {
    renderDialog({ error: "Token rejected by GitHub", success: true });

    expect(screen.getByText("Token rejected by GitHub")).toBeInTheDocument();
    expect(screen.getByText("GitHub connected successfully!")).toBeInTheDocument();
  });

  it("resets the form when the dialog closes", () => {
    const { onClosed, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
