// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";

// The list is not what this covers, so the popover's parts render inline.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: { children: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { mockFetchJson } = vi.hoisted(() => ({ mockFetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson: mockFetchJson }));

import { ModelPicker } from "@/components/shared/model-picker";

/**
 * The trigger names the model that will answer. A chat with no pick of its own
 * runs on the default, and the header has to say which one that is.
 */

const MODELS = {
  providers: [{ id: "anthropic", name: "Anthropic" }],
  models: {
    anthropic: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchJson.mockResolvedValue(MODELS);
});

describe("ModelPicker", () => {
  it("names the model that applies while nothing is picked", async () => {
    render(<ModelPicker value="" onChange={() => {}} fallback="anthropic/claude-sonnet-4" />);

    await waitFor(() =>
      expect(screen.getByTitle("Default: Claude Sonnet 4")).toHaveTextContent("Claude Sonnet 4"),
    );
  });

  it("keeps saying the picker has no model when there is no default either", async () => {
    render(<ModelPicker value="" onChange={() => {}} placeholder="No Model" />);

    await waitFor(() => expect(screen.getByText("No Model")).toBeInTheDocument());
  });

  it("prefers the picked model over the default", async () => {
    render(
      <ModelPicker
        value="anthropic/claude-sonnet-4"
        onChange={() => {}}
        fallback="anthropic/claude-sonnet-4"
        placeholder="No Model"
      />,
    );

    // The trigger and the row it selects share the name, and the trigger comes first.
    const [trigger] = await waitFor(() => screen.getAllByTitle("Claude Sonnet 4"));
    expect(trigger).toHaveTextContent("Claude Sonnet 4");
    expect(screen.queryByText("No Model")).not.toBeInTheDocument();
  });

  it("names a default the list does not carry", async () => {
    render(<ModelPicker value="" onChange={() => {}} fallback="ollama/qwen3-coder" />);

    await waitFor(() =>
      expect(screen.getByTitle("Default: qwen3-coder")).toHaveTextContent("qwen3-coder"),
    );
  });

  it("names the model to a screen reader when only the icon is drawn", async () => {
    render(
      <ModelPicker
        value=""
        onChange={() => {}}
        fallback="anthropic/claude-sonnet-4"
        hideLabelWhenNarrow
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Model: Claude Sonnet 4")).toBeTruthy());
  });
});
