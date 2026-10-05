// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { McpServerSheet } from "@/app/dashboard/settings/components/mcp-server-sheet";
import type { McpServerInput } from "@/hooks/use-mcp-servers";

type Props = Parameters<typeof McpServerSheet>[0];

function renderSheet(overrides: Partial<Props> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onTest = vi.fn().mockResolvedValue({ success: true, tools: [] });
  render(
    <McpServerSheet
      open
      onOpenChange={vi.fn()}
      server={null}
      onSave={onSave}
      onTest={onTest}
      {...overrides}
    />,
  );
  return {
    onSave: (overrides.onSave ?? onSave) as unknown as ReturnType<typeof vi.fn>,
    onTest: (overrides.onTest ?? onTest) as unknown as ReturnType<typeof vi.fn>,
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
