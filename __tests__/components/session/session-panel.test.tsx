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
