// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let mockSearchParams: URLSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockFetchJson = vi.fn();
const mockPatchJson = vi.fn();
vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  patchJson: (...args: unknown[]) => mockPatchJson(...args),
}));

// Replace the panel components so we only exercise Inbox's sync logic.
// EmailListPanel is stubbed with a real button wired to onSyncAll so the
// click-to-request path is tested end-to-end.
vi.mock("@/components/mail/email-list-panel", () => ({
  EmailListPanel: ({ onSyncAll, syncing }: { onSyncAll: () => void; syncing: boolean }) => (
    <button type="button" onClick={onSyncAll} disabled={syncing}>
      Sync
    </button>
  ),
}));

vi.mock("@/components/mail/email-detail-panel", () => ({
  EmailDetailPanel: () => <div />,
}));

vi.mock("@/components/mail/email-detail-sheet", () => ({
  EmailDetailSheet: () => <div />,
}));

import { Inbox } from "@/components/mail/inbox";

describe("Inbox sync button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockFetchJson.mockResolvedValue({ accounts: [], messages: [], hasMore: false });
  });

  it("syncs only the selected account when one is active", async () => {
    mockSearchParams = new URLSearchParams({ accountId: "acc-1" });
    render(<Inbox onCompose={vi.fn()} onAddAccount={vi.fn()} />);

    const syncButton = await screen.findByRole("button", { name: "Sync" });
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith("/api/email/accounts/acc-1/sync", {
        method: "POST",
      });
    });
    expect(mockFetchJson).not.toHaveBeenCalledWith("/api/email/sync", { method: "POST" });
  });

  it("syncs all accounts when no account is selected", async () => {
    render(<Inbox onCompose={vi.fn()} onAddAccount={vi.fn()} />);

    const syncButton = await screen.findByRole("button", { name: "Sync" });
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith("/api/email/sync", { method: "POST" });
    });
  });

  it("does not fire a second sync request while a sync is running", async () => {
    let resolveSync: (() => void) | undefined;
    mockFetchJson.mockImplementation((url: string) => {
      if (url === "/api/email/sync") {
        return new Promise((resolve) => {
          resolveSync = () => resolve({ synced: true, results: [] });
        });
      }
      return Promise.resolve({ accounts: [], messages: [], hasMore: false });
    });
    const syncCalls = () => mockFetchJson.mock.calls.filter(([url]) => url === "/api/email/sync");

    render(<Inbox onCompose={vi.fn()} onAddAccount={vi.fn()} />);
    const syncButton = await screen.findByRole("button", { name: "Sync" });

    fireEvent.click(syncButton);
    expect(syncButton).toBeDisabled();
    expect(syncCalls()).toHaveLength(1);

    // Clicking while disabled must not queue another sync
    fireEvent.click(syncButton);
    expect(syncCalls()).toHaveLength(1);

    resolveSync?.();
    await waitFor(() => expect(syncButton).toBeEnabled());
  });
});
