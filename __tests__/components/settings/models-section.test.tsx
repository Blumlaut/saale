// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModelsSection } from "@/app/dashboard/settings/sections/models-section";
import type { UserSettings } from "@/app/dashboard/settings/types";

// The section takes its values from the settings shell and only hands changes
// back, so the cases below watch `update` rather than the server.
const { settingsState, update } = vi.hoisted(() => ({
  settingsState: { current: null as UserSettings | null },
  update: vi.fn(),
}));

const { fetched } = vi.hoisted(() => ({
  fetched: { current: { value: Promise.resolve({ models: {} }) } },
}));

vi.mock("@/app/dashboard/settings/components/user-settings-provider", () => ({
  useUserSettings: () => ({
    settings: settingsState.current,
    loading: false,
    saving: false,
    saveState: "idle",
    update,
    save: vi.fn(),
  }),
}));

vi.mock("@/lib/http", () => ({
  fetchJson: () => fetched.current.value,
  patchJson: vi.fn().mockResolvedValue({}),
}));

// The provider cards talk to their own endpoints; those have their own cases.
vi.mock("@/app/dashboard/settings/components/provider-management", () => ({
  ProviderManagement: () => null,
}));

vi.mock("@/components/providers/model-limits-sheet", () => ({
  ModelLimitsSheet: () => null,
}));

vi.mock("@/components/shared/model-picker", () => ({
  ModelPicker: () => null,
}));

// The thinking levels come from a request of their own; the cases here are
// about the inventory.
vi.mock("@/hooks/use-thinking-levels", () => ({
  useModelThinkingLevels: () => ({ levels: [], reasoning: undefined, unsupported: false }),
}));

const baseSettings: UserSettings = {
  defaultModelProvider: "fixture",
  defaultModelName: "fixture-a",
  defaultThinkingLevel: "off",
  theme: "system",
  compactActivity: true,
  telegramToolNotices: false,
  agentCustomInstructions: null,
  coderCustomInstructions: null,
  emailWritingStyle: null,
  purposeModelOverrides: null,
  disabledModels: null,
  defaultToolConfig: null,
  coderToolConfig: null,
  toolPolicies: null,
  toolExposure: null,
  approvalDecisionModel: null,
  instanceApprovalDecisionModel: null,
  pushNotifications: null,
};

const INVENTORY = {
  providers: [
    { id: "fixture", name: "Fixture Co", modelCount: 2, modelsConfigurable: false },
    { id: "other", name: "Other Co", modelCount: 1, modelsConfigurable: false },
  ],
  models: {
    fixture: [
      {
        id: "fixture-a",
        name: "Fixture A",
        reasoning: false,
        vision: false,
        contextWindow: 200_000,
      },
      {
        id: "fixture-b",
        name: "Fixture B",
        reasoning: false,
        vision: false,
        contextWindow: 200_000,
      },
    ],
    other: [
      { id: "other-a", name: "Other A", reasoning: false, vision: false, contextWindow: 8_000 },
    ],
  },
  endpointLimits: {},
};

/** Open the folded inventory, which is where the switches live. */
async function openInventory(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Models/ }));
  await screen.findByText("Fixture Co");
}

const providerSwitch = (name: string) =>
  screen.getByRole("switch", { name: `Show or hide every model of ${name}` });

beforeEach(() => {
  update.mockClear();
  settingsState.current = { ...baseSettings };
  fetched.current.value = Promise.resolve(INVENTORY);
});

describe("settings · models", () => {
  it("hides every model of a provider when its switch goes off", async () => {
    render(<ModelsSection />);
    await openInventory();

    expect(providerSwitch("Fixture Co")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(providerSwitch("Fixture Co"));

    expect(update).toHaveBeenCalledWith({
      disabledModels: ["fixture:fixture-a", "fixture:fixture-b"],
    });
  });

  it("shows them again when it goes back on", async () => {
    settingsState.current = {
      ...baseSettings,
      disabledModels: ["fixture:fixture-a", "fixture:fixture-b", "other:other-a"],
    };
    render(<ModelsSection />);
    await openInventory();

    expect(providerSwitch("Other Co")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(providerSwitch("Fixture Co"));

    // The other provider keeps its own row hidden.
    expect(update).toHaveBeenCalledWith({ disabledModels: ["other:other-a"] });
  });

  it("clears the stored list once nothing is hidden", async () => {
    settingsState.current = { ...baseSettings, disabledModels: ["fixture:fixture-a"] };
    render(<ModelsSection />);
    await openInventory();

    fireEvent.click(screen.getByRole("switch", { name: "Show Fixture A" }));

    expect(update).toHaveBeenCalledWith({ disabledModels: null });
  });

  it("toggles one model without touching its provider's other models", async () => {
    render(<ModelsSection />);
    await openInventory();

    fireEvent.click(screen.getByRole("switch", { name: "Hide Fixture B" }));

    expect(update).toHaveBeenCalledWith({ disabledModels: ["fixture:fixture-b"] });
  });

  it("matches the provider on the listed models when a search is on", async () => {
    render(<ModelsSection />);
    await openInventory();

    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "fixture b" },
    });
    await waitFor(() => expect(screen.queryByText("Other Co")).not.toBeInTheDocument());

    // With a search on, the row says how many of the group it covers.
    fireEvent.click(
      screen.getByRole("switch", { name: "Show or hide the 1 listed models of Fixture Co" }),
    );

    expect(update).toHaveBeenCalledWith({ disabledModels: ["fixture:fixture-b"] });
  });

  it("names the instance default while no decision model is picked", () => {
    settingsState.current = { ...baseSettings, instanceApprovalDecisionModel: "custom:judge" };
    render(<ModelsSection />);

    expect(screen.getByText("Decision model")).toBeInTheDocument();
    expect(screen.getByText("Follows the instance default: custom:judge")).toBeInTheDocument();
  });

  it("says the built-in checks decide when neither side picks one", () => {
    render(<ModelsSection />);

    expect(screen.getByText("Not set. The built-in command checks decide.")).toBeInTheDocument();
  });

  it("clears the pick back to the instance default", () => {
    settingsState.current = { ...baseSettings, approvalDecisionModel: "custom:judge" };
    render(<ModelsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Clear the decision model" }));

    expect(update).toHaveBeenCalledWith({ approvalDecisionModel: null });
  });
});
