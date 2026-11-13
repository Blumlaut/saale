// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionPanel } from "@/components/session/session-panel";

/**
 * The panel shell both chats share.
 *
 * What matters here is the part a page cannot see: a tab is mounted on its
 * first visit and kept after that, so a running shell or a half-typed file
 * survives a switch.
 */

function Harness({ counts }: { counts: { first: () => void; second: () => void } }) {
  const [tab, setTab] = useState("first");
  return (
    <SessionPanel
      value={tab}
      onValueChange={setTab}
      tabs={[
        {
          id: "first",
          label: "First",
          content: (
            <button type="button" onClick={counts.first}>
              first content
            </button>
          ),
        },
        {
          id: "second",
          label: "Second",
          content: (
            <button type="button" onClick={counts.second}>
              second content
            </button>
          ),
        },
      ]}
    />
  );
}

describe("SessionPanel", () => {
  it("shows one trigger per tab and only the open tab's content", () => {
    render(<Harness counts={{ first: vi.fn(), second: vi.fn() }} />);

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "first content" })).toBeVisible();
    // Never visited: its content was never made.
    expect(screen.queryByRole("button", { name: "second content" })).toBeNull();
  });

  it("keeps a tab mounted while another one is shown", () => {
    render(<Harness counts={{ first: vi.fn(), second: vi.fn() }} />);

    fireEvent.click(screen.getByRole("tab", { name: "Second" }));

    expect(screen.getByRole("button", { name: "second content" })).toBeVisible();
    // Still in the document, so whatever it holds is still there.
    expect(screen.getByRole("button", { name: "first content", hidden: true })).not.toBeVisible();
  });
});

/**
 * The panel with its rail: `collapsed` is a prop the caller owns, so the
 * harness keeps it next to the tab, the way both chats do.
 */
function RailHarness({
  onExpand = vi.fn(),
  onCollapse = vi.fn(),
}: {
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [tab, setTab] = useState("first");
  const [collapsed, setCollapsed] = useState(true);
  return (
    <SessionPanel
      value={tab}
      onValueChange={setTab}
      collapsed={collapsed}
      label="thing panel"
      onExpand={() => {
        onExpand();
        setCollapsed(false);
      }}
      onCollapse={() => {
        onCollapse();
        setCollapsed(true);
      }}
      tabs={[
        {
          id: "first",
          label: "First",
          icon: <span data-testid="first-icon" />,
          content: <p>first content</p>,
        },
        {
          id: "second",
          label: "Second",
          icon: <span data-testid="second-icon" />,
          content: <p>second content</p>,
        },
      ]}
    />
  );
}

describe("SessionPanel: put away", () => {
  it("shows a rail of its tabs, which the strip does not", () => {
    render(<RailHarness />);

    expect(screen.getByRole("button", { name: "Show the thing panel" })).toBeVisible();
    expect(screen.getByRole("button", { name: "First" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Second" })).toBeVisible();
    // The strip's own control is gone with it.
    expect(screen.queryByRole("button", { name: "Hide the thing panel" })).toBeNull();
  });

  it("keeps the tabs mounted, so a shell in one of them keeps running", () => {
    render(<RailHarness />);

    expect(screen.getByText("first content", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("second content", { exact: true })).toBeNull();
  });

  it("opens the panel on the rail icon it was given", () => {
    const onExpand = vi.fn();
    render(<RailHarness onExpand={onExpand} />);

    fireEvent.click(screen.getByRole("button", { name: "Second" }));

    expect(onExpand).toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Second/ })).toHaveAttribute("aria-selected", "true");
  });

  it("brings the panel back on the tab it was left on", () => {
    const onExpand = vi.fn();
    render(<RailHarness onExpand={onExpand} />);

    fireEvent.click(screen.getByRole("button", { name: "Show the thing panel" }));

    expect(onExpand).toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /First/ })).toHaveAttribute("aria-selected", "true");
  });

  it("puts the panel away again from the strip's own control", () => {
    const onCollapse = vi.fn();
    render(<RailHarness onCollapse={onCollapse} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the thing panel" }));

    fireEvent.click(screen.getByRole("button", { name: "Hide the thing panel" }));

    expect(onCollapse).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show the thing panel" })).toBeVisible();
  });
});
