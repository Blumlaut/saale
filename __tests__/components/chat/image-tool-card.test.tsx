// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolCallGroup } from "@/components/chat/tool-call-group";
import type { ToolCallData } from "@/components/chat/types";

// The cards fetch their pictures; jsdom cannot, and the path is what the test
// reads, so the preview hook is answered directly.
vi.mock("@/components/chat/workspace-file", async () => {
  const actual = await vi.importActual<typeof import("@/components/chat/workspace-file")>(
    "@/components/chat/workspace-file",
  );
  return {
    ...actual,
    useFilePreview: () => ({ url: "blob:preview", failure: null }),
    useWorkspaceSession: () => null,
  };
});

/** A result with the metadata block the image tools append. */
function imageResult(path: string, prompt = "a fox"): string {
  return `Rendered "${prompt}" with Flux (1024×768). Saved to ${path} and shown to the user.\n${JSON.stringify(
    {
      _saaleImageMeta: {
        path,
        model: "flux",
        provider: "openrouter",
        prompt,
        width: 1024,
        height: 768,
      },
    },
  )}`;
}

function call(overrides: Partial<ToolCallData>): ToolCallData {
  return {
    id: "tc-1",
    name: "generate_image",
    args: { prompt: "a fox" },
    status: "completed",
    result: undefined,
    error: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ToolCallGroup with a rendered picture", () => {
  it("keeps the render in its own card, never among the shared files", () => {
    render(
      <ToolCallGroup
        toolCalls={[
          call({ id: "tc-img", result: imageResult("generated/fox.png") }),
          call({
            id: "tc-file",
            name: "show_file",
            args: { filePath: "notes.txt" },
            result: "Shared file",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Generate Image")).toBeInTheDocument();
    // The gallery reads `filePath`, which a render does not carry.
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  // The header holds one truncated line, so a long prompt is only readable in
  // the card and only copyable from there.
  it("shows a prompt too long for the header in full, and copies it", async () => {
    const prompt =
      "thuringian countryside, windmills, sweeping low hills, small patches of forest, morning haze";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <ToolCallGroup
        toolCalls={[call({ id: "tc-img", result: imageResult("generated/fox.png", prompt) })]}
      />,
    );

    // The header's copy is a span and truncates; this is the card's own line.
    expect(screen.getByText(prompt).tagName).toBe("P");

    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
  });

  // The card exists to show the sweep, so it opens by itself while the endpoint
  // works and reports no progress.
  it("opens the sweep while the render runs", () => {
    render(
      <ToolCallGroup toolCalls={[call({ id: "tc-img", status: "running", result: undefined })]} />,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName("Rendering the picture…");
  });
});
