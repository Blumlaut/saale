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
    // are found by their placeholder. Read lazily: a command server has no URL
    // field to find.
    get name() {
      return screen.getByPlaceholderText("homeassistant") as HTMLInputElement;
    },
    get url() {
      return screen.getByPlaceholderText(
        "https://homeassistant.local:8123/api/mcp",
      ) as HTMLInputElement;
    },
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
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    command: null,
    cwd: null,
    envNames: [],
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

/** A base-ui select commits on the pointer sequence, not a bare click. */
function chooseOption(select: HTMLElement, name: string) {
  fireEvent.click(select);
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

/**
 * A server is reachable over HTTP or by a command that runs in the user's
 * workspace. The command fields replace the endpoint, the token and the
 * sign-in, since a program authenticates with the account's own variables.
 */
describe("McpServerSheet command servers", () => {
  const command = "npx -y @modelcontextprotocol/server-filesystem .";

  it("offers a command only where the caller allows one", () => {
    renderSheet();
    expect(screen.queryByText("Connection")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/homeassistant\.local/)).toBeInTheDocument();
  });

  it("switches from an endpoint to a command and saves it", async () => {
    const { name, onSave } = renderSheet({ allowStdio: true });

    fireEvent.change(name, { target: { value: "files" } });
    chooseOption(screen.getByRole("combobox", { name: /connection/i }), "Command in workspace");

    const commandInput = screen.getByPlaceholderText(/server-filesystem/) as HTMLInputElement;
    expect(screen.queryByPlaceholderText(/homeassistant\.local/)).not.toBeInTheDocument();

    fireEvent.change(commandInput, { target: { value: command } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: "files",
      transport: "stdio",
      command,
      cwd: "",
    });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty("url");
  });

  it("reads a stored command back without asking for an endpoint", () => {
    renderSheet({
      server: savedServer({
        transport: "stdio",
        url: null,
        command,
        cwd: "docs",
        description: "Read the docs",
      }),
    });

    expect((screen.getByPlaceholderText(/server-filesystem/) as HTMLInputElement).value).toBe(
      command,
    );
    expect((screen.getByPlaceholderText(/Optional, e\.g\. docs/) as HTMLInputElement).value).toBe(
      "docs",
    );
    expect(screen.queryByPlaceholderText(/homeassistant\.local/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Access token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OAuth sign-in/)).not.toBeInTheDocument();
  });

  it("keeps the working directory inside the workspace", async () => {
    const { name, onSave } = renderSheet({ allowStdio: true });

    fireEvent.change(name, { target: { value: "files" } });
    chooseOption(screen.getByRole("combobox", { name: /connection/i }), "Command in workspace");
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), {
      target: { value: command },
    });
    fireEvent.change(screen.getByPlaceholderText(/Optional, e\.g\. docs/), {
      target: { value: "../another-account" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    expect(await screen.findByText(/cannot lead outside your workspace/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the variables a command was given, and never reads one back", async () => {
    const { name, onSave } = renderSheet({ allowStdio: true });

    fireEvent.change(name, { target: { value: "github" } });
    chooseOption(screen.getByRole("combobox", { name: /connection/i }), "Command in workspace");
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), {
      target: { value: "npx -y @modelcontextprotocol/server-github" },
    });
    fireEvent.change(screen.getByLabelText("Variable name"), {
      target: { value: "GITHUB_PERSONAL_ACCESS_TOKEN" },
    });
    fireEvent.change(screen.getByLabelText("Variable value"), {
      target: { value: "ghp_secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));

    // The list shows the name; the value it holds is not rendered.
    expect(screen.getByText("GITHUB_PERSONAL_ACCESS_TOKEN")).toBeInTheDocument();
    expect(screen.queryByText("ghp_secret")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
    });
  });

  it("lists a stored variable by name and forgets it when it is removed", async () => {
    const { onSave } = renderSheet({
      allowStdio: true,
      server: savedServer({
        transport: "stdio",
        url: null,
        command: "npx -y @modelcontextprotocol/server-github",
        envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN", "REGION"],
      }),
    });

    expect(screen.getByText("GITHUB_PERSONAL_ACCESS_TOKEN")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove GITHUB_PERSONAL_ACCESS_TOKEN" }));
    expect(screen.queryByText("GITHUB_PERSONAL_ACCESS_TOKEN")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      envRemove: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty("env");
  });

  it("refuses a variable name a shell could not read", () => {
    renderSheet({ allowStdio: true });

    chooseOption(screen.getByRole("combobox", { name: /connection/i }), "Command in workspace");
    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "not-a-name" } });
    fireEvent.change(screen.getByLabelText("Variable value"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));

    expect(screen.getByText(/Variable names start with a letter/i)).toBeInTheDocument();
  });

  it("fills the sheet from a preset and waits for the key it needs", async () => {
    const { onSave } = renderSheet({ allowStdio: true });

    chooseOption(screen.getByRole("combobox", { name: /start from a preset/i }), "GitHub");

    expect((screen.getByPlaceholderText(/server-filesystem/) as HTMLInputElement).value).toBe(
      "npx -y @modelcontextprotocol/server-github",
    );
    expect((screen.getByPlaceholderText("homeassistant") as HTMLInputElement).value).toBe("github");
    // The key it needs is named, and the field says what belongs in it.
    expect(screen.getByText("GITHUB_PERSONAL_ACCESS_TOKEN")).toBeInTheDocument();
    const value = screen.getByLabelText("Value of GITHUB_PERSONAL_ACCESS_TOKEN");

    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    expect(await screen.findByText(/give GITHUB_PERSONAL_ACCESS_TOKEN a value/i)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(value, { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: "github",
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-github",
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
    });
  });

  it("fills an endpoint preset without a command", () => {
    renderSheet({ allowStdio: true });

    chooseOption(screen.getByRole("combobox", { name: /start from a preset/i }), "Linear");

    expect(
      (screen.getByPlaceholderText("https://homeassistant.local:8123/api/mcp") as HTMLInputElement)
        .value,
    ).toBe("https://mcp.linear.app/mcp");
    expect(screen.queryByPlaceholderText(/server-filesystem/)).not.toBeInTheDocument();
  });

  it("tests the command rather than an endpoint", async () => {
    const { onTest } = renderSheet({ allowStdio: true });
    const test = onTest as unknown as ReturnType<typeof vi.fn>;

    chooseOption(screen.getByRole("combobox", { name: /connection/i }), "Command in workspace");
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), {
      target: { value: command },
    });
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    expect(test.mock.calls[0]![1]).toMatchObject({ transport: "stdio", command });
  });
});
