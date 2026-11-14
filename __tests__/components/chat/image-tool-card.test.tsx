// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
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
function imageResult(path: string): string {
  return `Rendered "a fox" with Flux (1024×768). Saved to ${path} and shown to the user.\n${JSON.stringify(
    {
      _saaleImageMeta: {
        path,
        model: "flux",
        provider: "openrouter",
        prompt: "a fox",
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

  // The card exists to show the sweep, so it opens by itself while the endpoint
  // works and reports no progress.
  it("opens the sweep while the render runs", () => {
    render(
      <ToolCallGroup toolCalls={[call({ id: "tc-img", status: "running", result: undefined })]} />,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName("Rendering the picture…");
  });
});
