// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { McpImportDialog } from "@/components/mcp/mcp-import-dialog";

type Props = Parameters<typeof McpImportDialog>[0];

function renderDialog(overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    onImport: vi.fn().mockResolvedValue({ created: [], skipped: [] }),
    ...overrides,
  };
  render(<McpImportDialog {...props} />);
  return {
    onImport: props.onImport as unknown as ReturnType<typeof vi.fn>,
    onOpenChange: props.onOpenChange as unknown as ReturnType<typeof vi.fn>,
    config: () => screen.getByLabelText("MCP config") as HTMLTextAreaElement,
    submit: () => screen.getByRole("button", { name: /import servers/i }),
  };
}

describe("McpImportDialog", () => {
  it("keeps importing disabled until there is something to import", () => {
    const { submit } = renderDialog();
    expect(submit()).toBeDisabled();
  });

  it("hands the pasted text to the import and closes when every entry landed", async () => {
    const { config, submit, onImport, onOpenChange } = renderDialog({
      onImport: vi.fn().mockResolvedValue({
        created: [{ id: "1", name: "memory" }],
        skipped: [],
      }),
    });

    fireEvent.change(config(), {
      target: { value: '{"mcpServers":{"memory":{"command":"npx -y server-memory"}}}' },
    });
    fireEvent.click(submit());

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0]![0]).toContain("mcpServers");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("reports the entries it could not add and stays open", async () => {
    const { config, submit, onOpenChange } = renderDialog({
      onImport: vi.fn().mockResolvedValue({
        created: [{ id: "1", name: "memory" }],
        skipped: [{ name: "broken", error: "This entry has neither a command nor a URL." }],
      }),
    });

    fireEvent.change(config(), { target: { value: "{}" } });
    fireEvent.click(submit());

    expect(await screen.findByText(/Added memory/)).toBeInTheDocument();
    expect(screen.getByText(/broken: This entry has neither/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows the error the import threw", async () => {
    const { config, submit } = renderDialog({
      onImport: vi.fn().mockRejectedValue(new Error("That is not valid JSON")),
    });

    fireEvent.change(config(), { target: { value: "nope" } });
    fireEvent.click(submit());

    expect(await screen.findByText(/That is not valid JSON/)).toBeInTheDocument();
  });
});
