// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImageLightbox, LightboxImage } from "@/components/chat/image-lightbox";

const SRC = "/api/chat/attachments/att-real-3";

describe("LightboxImage", () => {
  it("renders the inline image with a labelled zoom trigger and no open dialog", () => {
    render(<LightboxImage src={SRC} alt="photo.png" />);

    const trigger = screen.getByRole("button", { name: "View photo.png" });
    expect(trigger).toBeInTheDocument();

    const img = trigger.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(SRC);

    // The lightbox is closed until the image is clicked
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it("opens the full-viewport lightbox on click, showing the same image", () => {
    render(<LightboxImage src={SRC} alt="photo.png" />);

    fireEvent.click(screen.getByRole("button", { name: "View photo.png" }));

    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();

    // The enlarged image is the same source as the inline thumbnail
    const lightboxImg = dialog!.querySelector("img");
    expect(lightboxImg).not.toBeNull();
    expect(lightboxImg!.getAttribute("src")).toBe(SRC);
    expect(lightboxImg!.className).toContain("object-contain");
  });

  it("closes with the close button and reports onOpenChange", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ImageLightbox open={true} onOpenChange={onOpenChange} src={SRC} alt="photo.png" />,
    );

    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());

    // Parent switches the controlled state — the dialog unmounts
    rerender(<ImageLightbox open={false} onOpenChange={onOpenChange} src={SRC} alt="photo.png" />);
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });
});
