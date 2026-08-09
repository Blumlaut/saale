// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/react";
import { Checkbox } from "@/components/ui/checkbox";

describe("Checkbox", () => {
  it("renders checked state for both controlled and uncontrolled usage", () => {
    const { container: controlled } = render(<Checkbox checked />);
    const controlledRoot = controlled.querySelector('[data-slot="checkbox"]')!;
    expect(controlledRoot).toHaveAttribute("data-checked");
    expect(controlledRoot).not.toHaveAttribute("data-unchecked");

    const { container: uncontrolled } = render(<Checkbox defaultChecked />);
    const uncontrolledRoot = uncontrolled.querySelector('[data-slot="checkbox"]')!;
    expect(uncontrolledRoot).toHaveAttribute("data-checked");
    expect(uncontrolledRoot).toHaveAttribute("aria-checked", "true");
  });

  it("renders unchecked state by default", () => {
    const { container } = render(<Checkbox />);
    const root = container.querySelector('[data-slot="checkbox"]')!;
    expect(root).toHaveAttribute("data-unchecked");
    expect(root).not.toHaveAttribute("data-checked");
    expect(root).toHaveAttribute("aria-checked", "false");
  });

  it("renders indeterminate state", () => {
    const { container } = render(<Checkbox indeterminate />);
    const root = container.querySelector('[data-slot="checkbox"]')!;
    expect(root).toHaveAttribute("data-indeterminate");
    expect(root).not.toHaveAttribute("data-checked");
    expect(root).not.toHaveAttribute("data-unchecked");
    expect(root).toHaveAttribute("aria-checked", "mixed");
  });

  it("toggles on click and reports the new value via onCheckedChange", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Checkbox onCheckedChange={onCheckedChange} />);
    const root = container.querySelector('[data-slot="checkbox"]')!;

    fireEvent.click(root);
    expect(root).toHaveAttribute("data-checked");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());

    fireEvent.click(root);
    expect(root).toHaveAttribute("data-unchecked");
    expect(onCheckedChange).toHaveBeenCalledWith(false, expect.anything());
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
  });

  it("does not toggle when disabled", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Checkbox disabled onCheckedChange={onCheckedChange} />);
    const root = container.querySelector('[data-slot="checkbox"]')!;

    fireEvent.click(root);
    expect(root).toHaveAttribute("data-unchecked");
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("styles the checked/indeterminate states via base-ui data attributes", () => {
    const { container } = render(<Checkbox defaultChecked />);
    const root = container.querySelector('[data-slot="checkbox"]')!;
    const classes = root.className;

    // The checked fill must be driven by `data-checked` (base-ui) — the Radix
    // `data-state-checked` attribute is never emitted and would leave the
    // checkbox unstyled when checked (the bug this test guards against).
    expect(classes).toContain("data-checked:bg-primary");
    expect(classes).toContain("data-indeterminate:bg-primary");
    expect(classes).not.toMatch(/data-state-(checked|indeterminate)/);
  });
});
