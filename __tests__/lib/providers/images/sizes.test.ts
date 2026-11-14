import { describe, it, expect } from "vitest";
import {
  DEFAULT_IMAGE_SIZES,
  imageSizeParts,
  isImageSize,
  normalizeImageSizes,
  pickImageSize,
} from "@/lib/providers/images/sizes";

describe("image sizes", () => {
  it("takes a WxH an endpoint will render", () => {
    expect(isImageSize("1024x1024")).toBe(true);
    expect(isImageSize("2752x1536")).toBe(true);
    // A side the flow schedule cannot divide, one off the scale, junk.
    expect(isImageSize("1023x1024")).toBe(false);
    expect(isImageSize("32x32")).toBe(false);
    expect(isImageSize("8192x8192")).toBe(false);
    expect(isImageSize("1024×1024")).toBe(false);
    expect(isImageSize(1024)).toBe(false);
  });

  it("cleans a stored list: valid entries, no repeats, in order", () => {
    expect(
      normalizeImageSizes(["1024x1024", "bogus", "1024x1024", " 1536x1024 ", "512x512"]),
    ).toEqual(["1024x1024", "1536x1024", "512x512"]);
  });

  it("falls back to the default size rather than to no list", () => {
    expect(normalizeImageSizes([])).toEqual([...DEFAULT_IMAGE_SIZES]);
    expect(normalizeImageSizes(null)).toEqual([...DEFAULT_IMAGE_SIZES]);
    expect(normalizeImageSizes(["nonsense"])).toEqual([...DEFAULT_IMAGE_SIZES]);
  });

  it("caps the list so a picker stays a picker", () => {
    const many = [
      "1024x1024",
      "512x512",
      "768x768",
      "1024x1536",
      "1536x1024",
      "1536x2752",
      "2752x1536",
      "2048x2048",
    ];
    expect(normalizeImageSizes(many)).toHaveLength(6);
  });

  it("uses the account's first size unless the requested one is on the list", () => {
    const sizes = ["2048x2048", "1024x1024"];
    expect(pickImageSize(sizes, "1024x1024")).toBe("1024x1024");
    expect(pickImageSize(sizes, undefined)).toBe("2048x2048");
    expect(pickImageSize(sizes, "512x512")).toBe("2048x2048");
    expect(pickImageSize([], "1024x1024")).toBe(DEFAULT_IMAGE_SIZES[0]);
  });

  it("reads the two numbers a card needs to hold the shape", () => {
    expect(imageSizeParts("1536x2752")).toEqual({ width: 1536, height: 2752 });
    expect(imageSizeParts("big")).toBeUndefined();
  });
});
