// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

import { McpServerSheet } from "@/components/mcp/mcp-server-sheet";
import type { McpOAuthStart, McpServer, McpServerInput } from "@/hooks/use-mcp-servers";

type Props = Parameters<typeof McpServerSheet>[0];

/** The sheet with stand-in callbacks; `overrides` replaces any of them. */
function sheetProps(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    onOpenChange: vi.fn(),
    server: null,
    onSave: vi.fn().mockResolvedValue(undefined),
    onTest: vi.fn().mockResolvedValue({ success: true, tools: [] }),
    onStartOAuth: vi.fn().mockResolvedValue({ status: "pending", authorizationUrl: null }),
    onOAuthStatus: vi.fn().mockResolvedValue({
      status: "pending",
      error: null,
      authorizationUrl: null,
      hasOAuth: false,
    }),
    onSignOutOAuth: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderSheet(overrides: Partial<Props> = {}) {
  const props = sheetProps(overrides);
  const view = render(<McpServerSheet {...props} />);
  return {
    onSave: props.onSave as unknown as ReturnType<typeof vi.fn>,
    onTest: props.onTest as unknown as ReturnType<typeof vi.fn>,
    onStartOAuth: props.onStartOAuth as unknown as ReturnType<typeof vi.fn>,
    onSignOutOAuth: props.onSignOutOAuth as unknown as ReturnType<typeof vi.fn>,
    /** Re-open the same sheet for another server, as the page does. */
    openServer: (server: McpServer | null) =>
      view.rerender(<McpServerSheet {...props} server={server} />),
    // The sheet labels sit next to the inputs without `htmlFor`, so the fields
    // are found by their placeholder.
    name: screen.getByPlaceholderText("homeassistant") as HTMLInputElement,
    url: screen.getByPlaceholderText(
      "https://homeassistant.local:8123/api/mcp",
    ) as HTMLInputElement,
  };
}

/** Type into a controlled input the way a person does: one character at a time. */
function type(input: HTMLInputElement, text: string) {
  for (const char of text) {
    fireEvent.change(input, { target: { value: input.value + char } });
  }
}

describe("McpServerSheet name field", () => {
  it("keeps what was typed while typing and folds it when the field is left", () => {
    const { name } = renderSheet();

    type(name, "HA Admin");

    // Nothing may eat the space before it can become an underscore.
    expect(name.value).toBe("HA Admin");
    expect(screen.getByText(/mcp__ha_admin__HassTurnOn/)).toBeInTheDocument();

    fireEvent.blur(name);
    expect(name.value).toBe("ha_admin");
  });

  it("saves the folded name", async () => {
    const { name, url, onSave } = renderSheet();

    type(name, "Local Figma");
    fireEvent.change(url, { target: { value: "https://figma.example/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0]![0] as McpServerInput).name).toBe("local_figma");
  });

  it("reports a name that folds to nothing under the name field", async () => {
    const { name, url, onSave } = renderSheet();

    fireEvent.change(name, { target: { value: "!!!" } });
    fireEvent.change(url, { target: { value: "https://example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    expect(await screen.findByText(/give this server a name/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    // The message belongs to the name: the URL keeps its own hint.
    expect(screen.queryByText(/become underscores/i)).not.toBeInTheDocument();
    expect(screen.getByText(/streamable HTTP MCP endpoint/i)).toBeInTheDocument();
  });

  it("moves the message back to the URL when that field is the invalid one", async () => {
    const { name, url } = renderSheet();

    type(name, "github");
    fireEvent.change(url, { target: { value: "ftp://example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /test/i }));

    expect(await screen.findByText(/must be an http\(s\) URL/i)).toBeInTheDocument();
    expect(screen.getByText(/become underscores/i)).toBeInTheDocument();

    // Editing the field again clears its message.
    fireEvent.change(url, { target: { value: "https://example.com/mcp" } });
    expect(screen.queryByText(/must be an http\(s\) URL/i)).not.toBeInTheDocument();
  });
});

function savedServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    description: "",
    toolPolicy: "ask",
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

describe("McpServerSheet OAuth sign-in", () => {
  it("starts a sign-in and opens the authorization URL", async () => {
    const authorizationUrl = "https://auth.linear.app/authorize?client_id=saale&state=abc";
    const onStartOAuth = vi.fn().mockResolvedValue({ status: "pending", authorizationUrl });
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderSheet({ server: savedServer(), onStartOAuth });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(onStartOAuth).toHaveBeenCalledWith("srv-1"));
    expect(open).toHaveBeenCalledWith(authorizationUrl, "_blank", "noopener,noreferrer");
    // The URL is also reachable when the popup was blocked.
    expect(await screen.findByText(authorizationUrl)).toBeInTheDocument();
    open.mockRestore();
  });

  it("shows a stored sign-in and signs out", async () => {
    const onSignOutOAuth = vi.fn().mockResolvedValue(undefined);

    renderSheet({ server: savedServer({ hasOAuth: true }), onSignOutOAuth });

    expect(screen.getByText(/signed in/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(onSignOutOAuth).toHaveBeenCalledWith("srv-1"));
  });

  it("reads the next server's sign-in state instead of the last one's", async () => {
    const { openServer } = renderSheet({ server: savedServer({ hasOAuth: true }) });
    expect(screen.getByText(/signed in/i)).toBeInTheDocument();

    openServer(savedServer({ id: "srv-2", name: "cloudflare", url: "https://cloudflare.com/mcp" }));

    expect(await screen.findByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByText(/signed in/i)).not.toBeInTheDocument();
  });

  it("drops a sign-in that answers after the sheet moved to another server", async () => {
    let finish: (result: McpOAuthStart) => void = () => {};
    const onStartOAuth = vi.fn(
      () =>
        new Promise<McpOAuthStart>((resolve) => {
          finish = resolve;
        }),
    );

    const { openServer } = renderSheet({ server: savedServer(), onStartOAuth });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(onStartOAuth).toHaveBeenCalledWith("srv-1"));

    openServer(savedServer({ id: "srv-2", name: "cloudflare", url: "https://cloudflare.com/mcp" }));
    await act(async () => {
      finish({ status: "succeeded", authorizationUrl: null });
    });

    // The answer belongs to the server the user has left behind.
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByText(/signed in/i)).not.toBeInTheDocument();
  });

  it("asks for a save before signing in to a server that is not stored yet", () => {
    renderSheet();

    expect(screen.getByText(/save this server first/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
  });
});

/**
 * A server is configured for the kinds of session it belongs in: one for chat,
 * one for coding chats, or both.
 */
describe("McpServerSheet scopes", () => {
  it("saves a server that is coder-only", async () => {
    const { name, url, onSave } = renderSheet();

    fireEvent.change(name, { target: { value: "worktree" } });
    fireEvent.change(url, { target: { value: "https://worktree.example/mcp" } });
    fireEvent.click(screen.getByRole("switch", { name: "Connect in chat" }));
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ chatEnabled: false, coderEnabled: true });
  });

  it("reads the stored scopes back", () => {
    renderSheet({ server: savedServer({ chatEnabled: false }) });

    expect(screen.getByRole("switch", { name: "Connect in chat" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Connect in coder chats" })).toBeChecked();
  });

  it("says so when the server is switched off everywhere", () => {
    renderSheet({ server: savedServer({ chatEnabled: false, coderEnabled: false }) });

    expect(screen.getByText(/connects nowhere/i)).toBeInTheDocument();
  });
});
