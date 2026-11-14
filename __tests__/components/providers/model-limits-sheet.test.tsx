// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import {
  ModelLimitsSheet,
  type ModelLimitsTarget,
} from "@/components/providers/model-limits-sheet";

const { patchJson } = vi.hoisted(() => ({ patchJson: vi.fn() }));

vi.mock("@/lib/http", () => ({ patchJson }));

/** One image model the admin opened the sheet for. */
function target(overrides: Partial<ModelLimitsTarget> = {}): ModelLimitsTarget {
  return {
    provider: "custom",
    providerName: "llama-swap",
    modelId: "qwen-image-2.1-turbo",
    modelName: "qwen-image-2.1-turbo",
    contextWindow: undefined,
    maxOutputTokens: undefined,
    overrides: undefined,
    endpointLimits: null,
    image: true,
    imageSizes: undefined,
    ...overrides,
  };
}

function renderSheet(props: Partial<Parameters<typeof ModelLimitsSheet>[0]> = {}) {
  return render(
    <ModelLimitsSheet
      target={target()}
      onOpenChange={vi.fn()}
      capabilitiesEndpoint="/api/admin/providers/capabilities"
      onSaved={vi.fn()}
      allowImageSizes
      {...props}
    />,
  );
}

/** Open the resolutions dropdown. */
function openResolutions() {
  fireEvent.click(screen.getByLabelText("Pick resolutions"));
}

/** Click one of the dropdown's entries by the resolution it holds. */
function toggleOption(size: string) {
  const option = screen.getByRole("option", { name: new RegExp(size.replace("x", " × ")) });
  fireEvent.click(within(option).getByRole("checkbox"));
}

describe("the model sheet's resolutions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchJson.mockResolvedValue({});
  });

  it("offers the presets to the admin, and says what the agent does with them", () => {
    renderSheet();

    openResolutions();

    expect(screen.getByText("Resolutions")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /2048 × 2048/ })).toBeInTheDocument();
    expect(screen.getByText(/No list, so a render uses 1024×1024/)).toBeInTheDocument();
  });

  it("starts from the resolutions the model already has", () => {
    renderSheet({ target: target({ imageSizes: ["2048x2048", "1536x1024"] }) });

    expect(screen.getByText(/uses 2048×2048 unless it asks for another/)).toBeInTheDocument();
    openResolutions();
    expect(screen.getByText("2 of 6 picked")).toBeInTheDocument();
  });

  it("saves the picked list with the model's limits", async () => {
    renderSheet();

    openResolutions();
    toggleOption("2048x2048");
    toggleOption("1536x1024");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchJson).toHaveBeenCalled());
    expect(patchJson).toHaveBeenCalledWith(
      "/api/admin/providers/capabilities",
      expect.objectContaining({
        provider: "custom",
        modelId: "qwen-image-2.1-turbo",
        imageSizes: ["2048x2048", "1536x1024"],
      }),
    );
  });

  // The first entry is what a render uses, so picking a default is a move to
  // the front rather than a second thing to keep in sync.
  it("moves the chosen default to the front of the list", async () => {
    renderSheet();

    openResolutions();
    toggleOption("1024x1024");
    toggleOption("2048x2048");
    // Close the dropdown first: its entries and the select's are both options.
    fireEvent.click(screen.getByLabelText("Pick resolutions"));
    fireEvent.click(screen.getByLabelText("Default"));
    const option = await screen.findByRole("option", { name: "2048 × 2048" });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchJson).toHaveBeenCalled());
    expect(patchJson).toHaveBeenCalledWith(
      "/api/admin/providers/capabilities",
      expect.objectContaining({ imageSizes: ["2048x2048", "1024x1024"] }),
    );
  });

  it("offers no default until there is more than one size to choose between", () => {
    renderSheet({ target: target({ imageSizes: ["1024x1024"] }) });

    expect(screen.queryByText("Default")).toBeNull();
  });

  it("puts the model back on the default list", async () => {
    renderSheet({ target: target({ imageSizes: ["2048x2048"] }) });

    openResolutions();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchJson).toHaveBeenCalled());
    expect(patchJson).toHaveBeenCalledWith(
      "/api/admin/providers/capabilities",
      expect.objectContaining({ imageSizes: [] }),
    );
  });

  // The list describes what the endpoint renders. An account does not get to
  // decide that, so its sheet has no such section and sends nothing about it.
  it("keeps the resolutions out of the account's own sheet", async () => {
    renderSheet({ allowImageSizes: false });

    expect(screen.queryByText("Resolutions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchJson).toHaveBeenCalled());
    expect(patchJson.mock.calls[0]![1]).not.toHaveProperty("imageSizes");
  });

  it("leaves the section out for a model that renders no pictures", () => {
    renderSheet({ target: target({ image: false }) });

    expect(screen.queryByText("Resolutions")).toBeNull();
  });

  it("stops the admin picking more than the list holds", () => {
    renderSheet({
      target: target({
        imageSizes: ["1024x1024", "512x512", "768x768", "1024x1536", "1536x1024", "1536x2752"],
      }),
    });

    openResolutions();

    expect(screen.getByText("6 of 6 picked")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /2048 × 2048/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
