// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolsTab } from "@/app/dashboard/settings/tabs/tools-tab";
import type { UserSettings } from "@/app/dashboard/settings/types";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

/**
 * A stored `defaultToolConfig` is sparse and can predate a category: the row
 * only holds deviations, and a config written before a category existed does
 * not name it. The toggle must therefore read an absent key as the category's
 * registry default — otherwise a newly added category shows up switched off
 * (and flipping the switch back on stores `true`, i.e. a no-op).
 */

const baseSettings: UserSettings = {
  defaultModelProvider: "openai",
  defaultModelName: "gpt-4o",
  defaultThinkingLevel: "off",
  theme: "system",
  agentCustomInstructions: null,
  emailWritingStyle: null,
  purposeModelOverrides: null,
  disabledModels: null,
  defaultToolConfig: null,
  toolPolicies: null,
  toolExposure: null,
};

/** The category order is fixed, so the last switch is the last category. */
const lastCategory = TOOL_CATEGORIES[TOOL_CATEGORIES.length - 1]!;

function renderTab(settings: UserSettings) {
  const onSettingsChange = vi.fn();
  render(
    <ToolsTab
      settings={settings}
      onSettingsChange={onSettingsChange}
      saving={false}
      saveStatus="idle"
      onSave={vi.fn()}
    />,
  );
  const switches = screen.getAllByRole("switch");
  return { onSettingsChange, switches, lastSwitch: switches[switches.length - 1]! };
}

describe("ToolsTab category toggles", () => {
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
    const { switches, lastSwitch, onSettingsChange } = renderTab({
      ...baseSettings,
      defaultToolConfig: legacy,
    });

    expect(switches).toHaveLength(TOOL_CATEGORIES.length);
    expect(lastSwitch).toBeChecked();

    // Turning it off must store an explicit `false`, not flip `undefined`.
    fireEvent.click(lastSwitch);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultToolConfig: expect.objectContaining({ settings: false, infra: false }),
      }),
    );
  });

  it("honours an explicit false and turns it back on", () => {
    const { lastSwitch, onSettingsChange } = renderTab({
      ...baseSettings,
      defaultToolConfig: { settings: false },
    });

    expect(lastSwitch).not.toBeChecked();

    fireEvent.click(lastSwitch);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultToolConfig: expect.objectContaining({ settings: true }),
      }),
    );
  });
});
