import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// The module only needs the client for its write helpers; these cases are about
// the picture itself.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  AVATAR_SIZE,
  AVATAR_MAX_UPLOAD_BYTES,
  avatarUrl,
  processAvatar,
  validateAvatarUpload,
} from "@/lib/profile/avatar";

/** A solid-colour PNG of the given size, as an upload would arrive. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

function upload(buffer: Buffer, type: string): File {
  return new File([new Uint8Array(buffer)], "photo", { type });
}

describe("processAvatar", () => {
  it("stores one square WebP of the fixed size", async () => {
    const result = await processAvatar(await png(400, 400));

    expect(result.mimeType).toBe("image/webp");
    const meta = await sharp(Buffer.from(result.data)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(AVATAR_SIZE);
    expect(meta.height).toBe(AVATAR_SIZE);
  });

  it("crops a landscape photo instead of squashing it", async () => {
    const result = await processAvatar(await png(600, 200));

    const meta = await sharp(Buffer.from(result.data)).metadata();
    expect(meta.width).toBe(meta.height);
  });

  it("keeps the stored picture small enough to sit in a row", async () => {
    const result = await processAvatar(await png(1200, 1200));

    expect(result.data.byteLength).toBeLessThan(16 * 1024);
  });
});

describe("validateAvatarUpload", () => {
  it("accepts an image within the limits", async () => {
    expect(validateAvatarUpload(upload(await png(80, 80), "image/png"))).toBeNull();
  });

  it("refuses a file that is not an image", () => {
    const pdf = upload(Buffer.from("%PDF-1.4"), "application/pdf");

    expect(validateAvatarUpload(pdf)).toMatch(/image/i);
  });

  it("refuses an image larger than the ceiling", () => {
    const huge = upload(Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1), "image/png");

    expect(validateAvatarUpload(huge)).toMatch(/5 MB/);
  });
});

describe("avatarUrl", () => {
  it("carries the version so a new picture is fetched", () => {
    expect(avatarUrl("user-1", new Date(1_700_000_000_000))).toBe(
      "/api/profile/avatar/user-1?v=1700000000000",
    );
    expect(avatarUrl("user-1", 42)).toBe("/api/profile/avatar/user-1?v=42");
  });
});
