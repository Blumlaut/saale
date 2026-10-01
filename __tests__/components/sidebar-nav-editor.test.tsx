// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarNavEditor } from "@/app/dashboard/settings/components/sidebar-nav-editor";
import {
  SIDEBAR_NAV_ITEM_IDS,
  defaultSidebarNav,
  normalizeSidebarNav,
  type SidebarNavEntry,
} from "@/lib/navigation/sidebar-nav";

function ids(entries: SidebarNavEntry[]) {
  return entries.map((entry) => entry.id);
}

/** The layout an `onChange` call reported, or a clear failure when it didn't. */
function changedEntries(onChange: ReturnType<typeof vi.fn>, call = 0): SidebarNavEntry[] {
  const args = onChange.mock.calls[call] as [SidebarNavEntry[]] | undefined;
  if (!args) throw new Error(`onChange was not called (call ${call})`);
  return args[0];
}

function renderEditor(overrides: Partial<React.ComponentProps<typeof SidebarNavEditor>> = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const props = {
    entries: defaultSidebarNav(),
    saving: false,
    error: null,
    onChange,
    onReset,
    ...overrides,
  };
  render(<SidebarNavEditor {...props} />);
  return { onChange, onReset, props };
}

beforeEach(() => vi.clearAllMocks());

describe("SidebarNavEditor", () => {
  it("lists every sidebar item in layout order", () => {
    renderEditor();

    const labels = screen
      .getAllByRole("button", { name: /^Move .* (up|down)$/ })
      .map((button) => button.getAttribute("aria-label") ?? "");

    expect(labels[0]).toBe("Move Chat up");
    expect(labels[1]).toBe("Move Chat down");
    expect(labels[2]).toBe("Move Mail up");
    expect(screen.getByRole("switch", { name: "Show Settings in the sidebar" })).toBeChecked();
  });

  it("moves an item down and reports the whole layout", () => {
    const { onChange } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Move Chat down" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ids(changedEntries(onChange)).slice(0, 3)).toEqual(["mail", "chat", "calendar"]);
  });

  it("disables the boundary arrows", () => {
    renderEditor();

    expect(screen.getByRole("button", { name: "Move Chat up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Settings down" })).toBeDisabled();
  });

  it("hides an item when its switch is turned off", () => {
    const { onChange } = renderEditor();

    fireEvent.click(screen.getByRole("switch", { name: "Show Calendar in the sidebar" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = changedEntries(onChange);
    expect(next.find((entry) => entry.id === "calendar")).toEqual({
      id: "calendar",
      hidden: true,
    });
    expect(next).toHaveLength(7);
  });

  it("keeps the last visible item from being hidden", () => {
    // Everything but Tasks is hidden, so Tasks is the only way back in.
    const entries = normalizeSidebarNav(
      SIDEBAR_NAV_ITEM_IDS.map((id) => ({ id, hidden: id !== "tasks" })),
    );
    const { onChange } = renderEditor({ entries });

    const tasksSwitch = screen.getByRole("switch", { name: "Show Tasks in the sidebar" });
    expect(tasksSwitch).toHaveAttribute("data-disabled");
    expect(tasksSwitch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(tasksSwitch);
    expect(onChange).not.toHaveBeenCalled();

    // A hidden sibling can still be brought back.
    const chatSwitch = screen.getByRole("switch", { name: "Show Chat in the sidebar" });
    expect(chatSwitch).not.toHaveAttribute("data-disabled");
    fireEvent.click(chatSwitch);
    const next = changedEntries(onChange);
    expect(next.find((entry) => entry.id === "chat")?.hidden).toBe(false);
  });

  it("disables reset for the default layout", () => {
    renderEditor();

    expect(screen.getByRole("button", { name: /reset/i })).toBeDisabled();
  });

  it("resets a customized layout", () => {
    const customized = defaultSidebarNav().map((entry) =>
      entry.id === "mail" ? { ...entry, hidden: true } : entry,
    );
    const { onReset } = renderEditor({ entries: customized });

    const reset = screen.getByRole("button", { name: /reset/i });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("surfaces save failures", () => {
    renderEditor({ error: "Couldn't save your sidebar layout" });

    expect(screen.getByText("Couldn't save your sidebar layout")).toBeInTheDocument();
  });
});
