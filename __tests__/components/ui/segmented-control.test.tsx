// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SegmentedControl } from "@/components/ui/segmented-control";

/** The share audience and the thinking level both pick one option out of a row. */

const OPTIONS = [
  { value: "public", label: "Anyone with the link" },
  { value: "account", label: "Signed-in users" },
] as const;

describe("SegmentedControl", () => {
  it("shows every option and marks the current one", () => {
    render(
      <SegmentedControl
        label="Who can open the link"
        value="account"
        options={OPTIONS}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("group", { name: "Who can open the link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anyone with the link" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Signed-in users" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hands the picked value up", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Who can open the link"
        value="public"
        options={OPTIONS}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Signed-in users" }));
    expect(onChange).toHaveBeenCalledWith("account");

    // Picking the option that is already on still reports it: a caller may save it again.
    fireEvent.click(screen.getByRole("button", { name: "Anyone with the link" }));
    expect(onChange).toHaveBeenLastCalledWith("public");
  });

  it("cannot be picked while the caller is saving", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Who can open the link"
        value="public"
        options={OPTIONS}
        onChange={onChange}
        disabled
      />,
    );

    const option = screen.getByRole("button", { name: "Signed-in users" });
    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("carries an option's description as its tooltip", () => {
    render(
      <SegmentedControl
        label="Thinking level"
        value="high"
        options={[{ value: "high", label: "High", title: "Thinks for longer" }]}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "High" })).toHaveAttribute(
      "title",
      "Thinks for longer",
    );
  });
});
