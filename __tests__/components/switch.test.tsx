// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/react";
import { Switch } from "@/components/ui/switch";

/**
 * The switch track uses fixed pixel dimensions (`w-[32px]` / `w-[24px]`), so the
 * thumb MUST also be fixed pixel sized (`size-[16px]` / `size-[12px]`). A rem-based
 * thumb (`size-4` / `size-3`) shrinks with the responsive root font-size on mobile
 * (14px vs 17px on desktop), and since the checked translate is `calc(100% - 2px)`
 *  a percentage of the thumb's own width  the thumb ends up short of the track's
 * right edge on small viewports (the "switch circle not at the very right edge" bug).
 */
function expectFixedPxThumb(root: Element, expected: "16px" | "12px") {
  const thumb = root.querySelector('[data-slot="switch-thumb"]');
  expect(thumb).not.toBeNull();
  const classes = thumb!.className;
  expect(classes).toContain(`size-[${expected}]`);
  // Regression guard: rem-based sizing must not come back.
  expect(classes).not.toMatch(/size-[34]/);
}

describe("Switch", () => {
  it("renders checked state for both controlled and uncontrolled usage", () => {
    const { container: controlled } = render(<Switch checked />);
    const controlledRoot = controlled.querySelector('[data-slot="switch"]')!;
    expect(controlledRoot).toHaveAttribute("data-checked");
    expect(controlledRoot).not.toHaveAttribute("data-unchecked");

    const { container: uncontrolled } = render(<Switch defaultChecked />);
    const uncontrolledRoot = uncontrolled.querySelector('[data-slot="switch"]')!;
    expect(uncontrolledRoot).toHaveAttribute("data-checked");
  });

  it("renders unchecked state by default", () => {
    const { container } = render(<Switch />);
    const root = container.querySelector('[data-slot="switch"]')!;
    expect(root).toHaveAttribute("data-unchecked");
    expect(root).not.toHaveAttribute("data-checked");
  });

  it("toggles on click and reports the new value via onCheckedChange", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Switch onCheckedChange={onCheckedChange} />);
    const root = container.querySelector('[data-slot="switch"]')!;

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
    const { container } = render(<Switch disabled onCheckedChange={onCheckedChange} />);
    const root = container.querySelector('[data-slot="switch"]')!;

    fireEvent.click(root);
    expect(root).toHaveAttribute("data-unchecked");
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("uses fixed-px thumb sizes that match the fixed-px track at every breakpoint", () => {
    const { container: defaultSize } = render(<Switch />);
    const defaultRoot = defaultSize.querySelector('[data-slot="switch"]')!;
    expect(defaultRoot.className).toContain("w-[32px]");
    expectFixedPxThumb(defaultRoot, "16px");

    const { container: smSize } = render(<Switch size="sm" />);
    const smRoot = smSize.querySelector('[data-slot="switch"]')!;
    expect(smRoot.className).toContain("w-[24px]");
    expectFixedPxThumb(smRoot, "12px");
  });
});
