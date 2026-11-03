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

// The MCP servers live in their own table; the page only reads the list and
// writes a server's scope.
const { mcpState, updateMcpServer } = vi.hoisted(() => ({
  mcpState: {
    current: {
      servers: [] as Array<{
        id: string;
        name: string;
        description: string;
        enabled: boolean;
        chatEnabled: boolean;
        coderEnabled: boolean;
      }>,
      loading: false,
      error: null as string | null,
    },
  },
  updateMcpServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({
    servers: mcpState.current.servers,
    loading: mcpState.current.loading,
    error: mcpState.current.error,
    updateServer: updateMcpServer,
  }),
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
 * The chat switches only: every row carries a coder switch too, and that scope
 * has cases of its own below.
 */
function categorySwitches(): HTMLElement[] {
  return screen
    .getAllByRole("switch")
    .filter((element) => (element.getAttribute("aria-label") ?? "").endsWith(" in chat"));
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

/**
 * The MCP category has no tools of its own: its tools come from the servers the
 * user connected in Integrations. It still carries the two settings every
 * category has, so a server set can be turned off or moved behind codemode.
 */
describe("Tools MCP category", () => {
  function expandRow(categoryLabel: string) {
    fireEvent.click(screen.getByRole("button", { name: `Expand ${categoryLabel}` }));
  }

  it("sets how the MCP tools reach the model", () => {
    const { update } = renderTab({ ...baseSettings });

    expandRow("MCP servers");

    const availability = screen.getAllByRole("combobox");
    fireEvent.click(availability[0]!);
    const option = screen.getByRole("option", { name: "Always available" });
    // A base-ui item commits on the pointer sequence, not a bare click.
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);

    expect(update).toHaveBeenCalledWith({ toolExposure: { mcp: "direct" } });
  });

  it("turns the whole set off with the category switch", () => {
    const { update } = renderTab({ ...baseSettings });

    fireEvent.click(screen.getByRole("switch", { name: "MCP servers in chat" }));

    expect(update).toHaveBeenCalledWith({
      defaultToolConfig: expect.objectContaining({ mcp: false }),
    });
  });
});

/**
 * A category is enabled per scope: what a new conversation starts with, and
 * what a new coding chat starts with. Both live on one row, and neither writes
 * the other's column.
 */
describe("Tools scopes", () => {
  it("gives every category a chat switch and a coder switch", () => {
    renderTab({ ...baseSettings });

    for (const category of TOOL_CATEGORIES) {
      expect(
        screen.getByRole("switch", { name: `${category.label} in chat` }),
        category.key,
      ).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: `${category.label} in coder chats` }),
        category.key,
      ).toBeInTheDocument();
    }
  });

  it("keeps the chat column and the coder column apart", () => {
    const { update } = renderTab({
      ...baseSettings,
      defaultToolConfig: { email: true },
      coderToolConfig: { email: false },
    });

    expect(screen.getByRole("switch", { name: "Email in chat" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Email in coder chats" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: "Email in coder chats" }));

    const change = update.mock.calls[0]![0] as Partial<UserSettings>;
    expect(change.coderToolConfig).toMatchObject({ email: true });
    expect(change).not.toHaveProperty("defaultToolConfig");
  });
});

/**
 * The MCP category has no tools of its own, so its expanded body lists the
 * servers instead, with the same two switches a category row carries.
 */
describe("Tools MCP servers", () => {
  function server(overrides: Record<string, unknown> = {}) {
    return {
      id: "srv-1",
      name: "homeassistant",
      description: "Control the smart home",
      enabled: true,
      chatEnabled: true,
      coderEnabled: true,
      ...overrides,
    };
  }

  function expandMcp() {
    fireEvent.click(screen.getByRole("button", { name: "Expand MCP servers" }));
  }

  it("lists the servers with a switch per scope", () => {
    mcpState.current = { servers: [server()], loading: false, error: null };
    renderTab({ ...baseSettings });

    expect(screen.queryByText("homeassistant")).not.toBeInTheDocument();

    expandMcp();

    expect(screen.getByText("homeassistant")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "homeassistant in chat" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "homeassistant in coder chats" })).toBeChecked();
  });

  it("writes a server's scope to its own row", () => {
    updateMcpServer.mockClear();
    mcpState.current = { servers: [server()], loading: false, error: null };
    renderTab({ ...baseSettings });

    expandMcp();
    fireEvent.click(screen.getByRole("switch", { name: "homeassistant in coder chats" }));

    expect(updateMcpServer).toHaveBeenCalledWith("srv-1", { coderEnabled: false });
    // The page's own autosave holds categories, not servers.
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves a switched-off server's scopes alone", () => {
    mcpState.current = { servers: [server({ enabled: false })], loading: false, error: null };
    renderTab({ ...baseSettings });

    expandMcp();

    expect(screen.getByText("homeassistant").parentElement?.textContent).toContain("off");
    // Base UI marks a disabled switch with aria-disabled, not the attribute.
    expect(screen.getByRole("switch", { name: "homeassistant in chat" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("points at the integrations page when no server is configured", () => {
    mcpState.current = { servers: [], loading: false, error: null };
    renderTab({ ...baseSettings });

    expandMcp();

    expect(screen.getByText(/No servers yet/)).toBeInTheDocument();
  });
});
