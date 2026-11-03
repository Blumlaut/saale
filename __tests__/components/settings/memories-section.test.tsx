// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoriesSection } from "@/app/dashboard/settings/sections/memories-section";

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock("@/lib/http", () => ({
  fetchJson,
  postJson: vi.fn(),
  patchJson: vi.fn(),
  deleteJson: vi.fn(),
}));

/**
 * A load that fails used to leave the panel looking like an account with no
 * memories. It now says so, and says why in the console.
 */

const MEMORY = {
  id: "memory-1",
  collection: "facts",
  title: "Prefers tabs",
  content: "The user prefers tabs over spaces.",
  tags: ["style"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  fetchJson.mockReset();
});

describe("settings · memories", () => {
  it("says a failed load out loud", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchJson.mockRejectedValue(new Error("network down"));

    render(<MemoriesSection />);

    expect(await screen.findByText("Could not load your memories.")).toBeVisible();
    expect(logged).toHaveBeenCalledWith("Failed to load memories:", expect.any(Error));
    logged.mockRestore();
  });

  it("shows the memories it loaded", async () => {
    fetchJson.mockImplementation((url: string) =>
      url.startsWith("/api/memories/collections")
        ? Promise.resolve({ collections: [{ name: "facts", count: 1, topTags: [] }], total: 1 })
        : Promise.resolve({ memories: [MEMORY], total: 1 }),
    );

    render(<MemoriesSection />);

    expect(await screen.findByText("Prefers tabs")).toBeVisible();
    expect(screen.queryByText("Could not load your memories.")).not.toBeInTheDocument();
  });
});
