// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WatcherList } from "@/components/jobs/watcher-list";
import type { ScriptWatcher } from "@/types/shared";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetchJson = vi.fn();
vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  patchJson: vi.fn(),
  deleteJson: vi.fn(),
}));

const day = (offset = 0) => new Date(Date.now() - offset * 86_400_000).toISOString();

function watcher(overrides: Partial<ScriptWatcher> = {}): ScriptWatcher {
  return {
    id: "w-1",
    name: "Price watch",
    description: null,
    script: "return 1;",
    cronExpression: "*/10 * * * *",
    enabled: true,
    sessionId: "chat-1",
    sessionTitle: "Trip planning",
    wakePrompt: "Check the price.",
    modelId: null,
    cooldownMinutes: 0,
    grantedTools: [],
    grantAll: false,
    needsApproval: false,
    tickCount: 0,
    fireCount: 0,
    lastTickAt: null,
    lastFiredAt: null,
    lastError: null,
    lastValue: null,
    createdAt: day(3),
    updatedAt: day(1),
    ...overrides,
  };
}

async function renderWith(watchers: ScriptWatcher[], expectedName: string) {
  mockFetchJson.mockImplementation(async (url: string) =>
    url === "/api/watchers" ? { watchers } : { ticks: [] },
  );
  render(<WatcherList />);
  // The list fetch resolves before the row is interactive.
  await screen.findByText(expectedName);
}

describe("WatcherList chat link", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockFetchJson.mockReset();
  });

  it("links a watcher's session title into its chat", async () => {
    await renderWith([watcher()], "Price watch");

    const link = screen.getByRole("button", { name: "Open chat Trip planning" });
    expect(link.textContent).toContain("Trip planning");

    fireEvent.click(link);
    expect(mockPush).toHaveBeenCalledWith("/dashboard/chat/chat-1");
  });

  it("does not select the row when opening the chat", async () => {
    await renderWith([watcher()], "Price watch");

    fireEvent.click(screen.getByRole("button", { name: "Open chat Trip planning" }));

    // Selection loads the tick history from a second request — none happened.
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it("shows plain text for a standalone watcher without a chat", async () => {
    await renderWith(
      [watcher({ id: "w-2", name: "Standalone", sessionId: null, sessionTitle: null })],
      "Standalone",
    );
    expect(screen.getByText("No conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open chat/ })).not.toBeInTheDocument();
  });

  it("falls back to the watcher name in the label when the chat has no title", async () => {
    await renderWith([watcher({ sessionTitle: null })], "Price watch");

    expect(
      await screen.findByRole("button", { name: "Open chat Price watch" }),
    ).toBeInTheDocument();
  });
});
