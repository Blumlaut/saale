// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("the model sheet's resolutions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchJson.mockResolvedValue({});
  });

  it("offers the presets to the admin, and says what the agent does with them", () => {
    renderSheet();

    expect(screen.getByText("Resolutions")).toBeInTheDocument();
    expect(screen.getByText(/renders at 1024×1024/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2048×2048" })).toBeInTheDocument();
  });

  it("starts from the resolutions the model already has", () => {
    renderSheet({ target: target({ imageSizes: ["2048x2048", "1536x1024"] }) });

    expect(screen.getByRole("button", { name: "2048×2048" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/uses 2048×2048 by default/)).toBeInTheDocument();
  });

  it("saves the picked list with the model's limits", async () => {
    renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "2048×2048" }));
    fireEvent.click(screen.getByRole("button", { name: "1536×1024" }));
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

  it("puts the model back on the default list", async () => {
    renderSheet({ target: target({ imageSizes: ["2048x2048"] }) });

    fireEvent.click(screen.getByRole("button", { name: "Back to the default" }));
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

    expect(screen.getByRole("button", { name: "2048×2048" })).toBeDisabled();
  });
});
