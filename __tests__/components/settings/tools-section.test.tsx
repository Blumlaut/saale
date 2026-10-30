// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolsSection } from "@/app/dashboard/settings/sections/tools-section";
import type { UserSettings } from "@/app/dashboard/settings/types";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

// The section reads the settings load from the settings shell; the cases below
// only care about what it tells that shell to store.
const { settingsState, update } = vi.hoisted(() => ({
  settingsState: { current: null as UserSettings | null },
  update: vi.fn(),
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

/**
 * A stored `defaultToolConfig` is sparse and can predate a category: the row
 * only holds deviations, and a config written before a category existed does
 * not name it. The toggle must therefore read an absent key as the category's
 * registry default  otherwise a newly added category shows up switched off
 * (and flipping the switch back on stores `true`, i.e. a no-op).
 */

const baseSettings: UserSettings = {
  defaultModelProvider: "openai",
  defaultModelName: "gpt-4o",
  defaultThinkingLevel: "off",
  theme: "system",
  compactActivity: true,
  agentCustomInstructions: null,
  coderCustomInstructions: null,
  emailWritingStyle: null,
  purposeModelOverrides: null,
  disabledModels: null,
  defaultToolConfig: null,
  coderToolConfig: null,
  toolPolicies: null,
  toolExposure: null,
  pushNotifications: null,
};

/** The category order is fixed, so the last switch is the last category. */
const lastCategory = TOOL_CATEGORIES[TOOL_CATEGORIES.length - 1]!;

/**
 * The category switches only: the coder section renders one per category too,
 * and it is not what these cases are about.
 */
function categorySwitches(): HTMLElement[] {
  return screen
    .getAllByRole("switch")
    .filter((element) => !(element.getAttribute("aria-label") ?? "").endsWith("coder chats"));
}

function renderTab(settings: UserSettings) {
  settingsState.current = settings;
  update.mockClear();
  render(<ToolsSection />);
  const switches = categorySwitches();
  return { update, switches, lastSwitch: switches[switches.length - 1]! };
}

describe("Tools category toggles", () => {
  it("reads a category missing from the stored config as enabled by default", () => {
    expect(lastCategory.key).toBe("settings");
    expect(lastCategory.defaultEnabled).toBe(true);

    // A config written before the "settings" category existed.
    const legacy = {
      terminal: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
      tasks: true,
      agentJobs: true,
      infra: false,
    };
    const { switches, lastSwitch, update } = renderTab({
      ...baseSettings,
      defaultToolConfig: legacy,
    });

    expect(switches).toHaveLength(TOOL_CATEGORIES.length);
    expect(lastSwitch).toBeChecked();

    // Turning it off must store an explicit `false`, not flip `undefined`.
    fireEvent.click(lastSwitch);
    expect(update).toHaveBeenCalledWith({
      defaultToolConfig: expect.objectContaining({ settings: false, infra: false }),
    });
  });

  it("honours an explicit false and turns it back on", () => {
    const { lastSwitch, update } = renderTab({
      ...baseSettings,
      defaultToolConfig: { settings: false },
    });

    expect(lastSwitch).not.toBeChecked();

    fireEvent.click(lastSwitch);
    expect(update).toHaveBeenCalledWith({
      defaultToolConfig: expect.objectContaining({ settings: true }),
    });
  });
});

/**
 * A coder chat starts from the coder defaults rather than the chat ones, so the
 * section reads a missing `coderToolConfig` against `CODER_TOOL_DEFAULTS` and
 * writes the whole map back to the `coderToolConfig` column.
 */
describe("Tools coder defaults", () => {
  function coderSwitches(): HTMLElement[] {
    return screen
      .getAllByRole("switch")
      .filter((element) => (element.getAttribute("aria-label") ?? "").endsWith("coder chats"));
  }

  it("renders one toggle per category and starts from the coder defaults", () => {
    renderTab({ ...baseSettings });
    const switches = coderSwitches();

    expect(switches).toHaveLength(TOOL_CATEGORIES.length);
    const byLabel = (label: string) =>
      screen.getByRole("switch", { name: `${label} in coder chats` });
    expect(byLabel("Terminal")).toBeChecked();
    expect(byLabel("Web")).toBeChecked();
    expect(byLabel("Memory")).toBeChecked();
    expect(byLabel("Email")).not.toBeChecked();
    expect(byLabel("Calendar")).not.toBeChecked();
  });

  it("writes a flipped category as a full coderToolConfig column", () => {
    const { update } = renderTab({ ...baseSettings });

    fireEvent.click(screen.getByRole("switch", { name: "Email in coder chats" }));

    const change = update.mock.calls[0]![0] as Partial<UserSettings>;
    expect(change.coderToolConfig).toMatchObject({ email: true, terminal: true, memory: true });
    // Every category is named, so a category the row does not hold is explicit.
    expect(Object.keys(change.coderToolConfig ?? {})).toHaveLength(TOOL_CATEGORIES.length);
  });
});

/**
 * Tools no category owns (`codemode`) are active whatever the category switches
 * say, so they get a policy of their own and no switch  a switch there would
 * claim to govern them and would not.
 */
describe("Tools always-active tools", () => {
  /**
   * The policy a row is set to. Read from the option list: a closed trigger
   * shows the stored value, not the label of the item it selects.
   */
  function selectedPolicy(trigger: HTMLElement): string {
    fireEvent.click(trigger);
    const selected = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true");
    if (!selected) throw new Error("no option is selected");
    return selected.textContent ?? "";
  }

  it("lists the codemode policy outside the categories, and offers Auto for it", () => {
    const { switches } = renderTab({ ...baseSettings });

    expect(screen.getByText("Always active")).toBeInTheDocument();
    expect(screen.getByText("Script")).toBeInTheDocument();
    // A row with a policy, but no switch claiming to turn it off.
    expect(switches).toHaveLength(TOOL_CATEGORIES.length);

    // No category is expanded, so the only policy select on the page is
    // codemode's  and its default resolves to the Auto item, which is only
    // offered where the gate decides from the call.
    const policies = screen.getAllByRole("combobox");
    expect(policies).toHaveLength(1);
    expect(selectedPolicy(policies[0]!)).toBe("Auto");
  });

  it("shows the policy the user stored", () => {
    renderTab({ ...baseSettings, toolPolicies: { codemode: "off" } });

    expect(selectedPolicy(screen.getByRole("combobox"))).toBe("Block");
  });
});
