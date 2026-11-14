// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MultiSelect } from "@/components/ui/multi-select";

/** The dropdown is a shared control; the cap is what a caller sets when the list has a ceiling. */

const OPTIONS = [
  { value: "1024x1024", label: "1024 × 1024 · square" },
  { value: "2048x2048", label: "2048 × 2048 · large square" },
  { value: "2752x1536", label: "2752 × 1536 · widescreen" },
] as const;

function open(name = "Pick resolutions") {
  fireEvent.click(screen.getByLabelText(name));
}

function toggle(label: string) {
  fireEvent.click(
    within(screen.getByRole("option", { name: new RegExp(label) })).getByRole("checkbox"),
  );
}

describe("MultiSelect", () => {
  it("reports a pick and hands the whole list back", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        value={["1024x1024"]}
        onChange={onChange}
        placeholder="Pick resolutions"
      />,
    );

    open();
    toggle("2048 × 2048");

    expect(onChange).toHaveBeenCalledWith(["1024x1024", "2048x2048"]);
  });

  it("drops a picked value when it is toggled off", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        value={["1024x1024", "2048x2048"]}
        onChange={onChange}
        placeholder="Pick resolutions"
      />,
    );

    open();
    toggle("1024 × 1024");

    expect(onChange).toHaveBeenCalledWith(["2048x2048"]);
  });

  // A list with a ceiling has to say so before the admin hits it: the count is
  // in the footer, and the entries left over are marked as unavailable.
  it("counts against the cap and refuses the entries past it", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        value={["1024x1024", "2048x2048"]}
        onChange={onChange}
        max={2}
        placeholder="Pick resolutions"
      />,
    );

    open();

    expect(screen.getByText("2 of 2 picked")).toBeInTheDocument();
    const left = screen.getByRole("option", { name: /2752 × 1536/ });
    expect(left).toHaveAttribute("aria-disabled", "true");

    toggle("2752 × 1536");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the entries a picked value occupies removable at the cap", () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        value={["1024x1024", "2048x2048"]}
        onChange={onChange}
        max={2}
        placeholder="Pick resolutions"
      />,
    );

    open();
    toggle("2048 × 2048");

    expect(onChange).toHaveBeenCalledWith(["1024x1024"]);
  });
});
