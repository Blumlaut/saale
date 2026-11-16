// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { McpServerRowActions } from "@/components/mcp/mcp-server-row-actions";
import type { McpServer } from "@/hooks/use-mcp-servers";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    name: "stackoverflow",
    transport: "http",
    url: "https://agents.stackoverflow.com/mcp",
    command: null,
    cwd: null,
    envNames: [],
    description: "",
    toolPolicy: "allow",
    enabled: true,
    chatEnabled: true,
    coderEnabled: true,
    hasToken: false,
    hasOAuth: false,
    shared: false,
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function renderActions(overrides: Partial<Parameters<typeof McpServerRowActions>[0]> = {}) {
  const props = {
    server: server(),
    busy: false,
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<McpServerRowActions {...props} />);
  return props;
}

describe("McpServerRowActions", () => {
  it("offers the sign-in from the row menu", () => {
    const onSignIn = vi.fn();
    renderActions({ onSignIn });

    fireEvent.click(screen.getByRole("button", { name: /actions for stackoverflow/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /sign in/i }));

    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("leaves the sign-in out when the caller has none", () => {
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: /actions for stackoverflow/i }));

    expect(screen.queryByRole("menuitem", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /edit/i })).toBeInTheDocument();
  });

  it("adds no control to the row itself", () => {
    renderActions({ onSignIn: vi.fn() });

    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    // The switch and the menu, so offering a sign-in never shifts the row.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(labels).toEqual(["Actions for stackoverflow"]);
  });
});
