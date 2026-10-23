import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePreviewHost,
  previewConfig,
  previewHost,
  previewIdentitySlug,
  previewUrl,
} from "@/lib/preview/url";

const KEY = "0123456789abcdef0123456789abcdef";
// A real user id is 32 base62 characters, mixed case.
const USER = "user-yy7vfya8Gg33Y5ROHdK2WhZRKvGqs5NA";
const IDENTITY = "user-c1a2b3c4d5e6f7g8h9i0j1k2l";

beforeEach(() => {
  vi.stubEnv("SANDBOX_API_KEY", KEY);
  vi.stubEnv("BETTER_AUTH_URL", "https://saale.example.com");
  vi.stubEnv("PREVIEW_DOMAIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the preview domain", () => {
  it("is derived from the public URL", () => {
    expect(previewConfig()).toEqual({ domain: "preview.saale.example.com", scheme: "https" });
  });

  it("prefers PREVIEW_DOMAIN, however it was pasted", () => {
    vi.stubEnv("PREVIEW_DOMAIN", "https://Previews.Other.Example.org/");
    expect(previewConfig()).toEqual({ domain: "previews.other.example.org", scheme: "https" });
  });

  it("stays off for localhost and for a bare address", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3630");
    expect(previewConfig().domain).toBeNull();

    vi.stubEnv("BETTER_AUTH_URL", "http://192.168.1.10:3630");
    expect(previewConfig().domain).toBeNull();
  });

  it("turns off rather than throwing on a URL it cannot read", () => {
    vi.stubEnv("BETTER_AUTH_URL", "not a url");
    expect(previewConfig().domain).toBeNull();
  });
});

describe("building a preview hostname", () => {
  it("carries the workspace, the port and a signature, inside one DNS label", () => {
    const host = previewHost(IDENTITY, 5173);
    const [label, ...rest] = host.split(".");

    expect(rest.join(".")).toBe("preview.saale.example.com");
    expect(label).toMatch(/^[0-9a-f]{10}-5173-[0-9a-f]{16}$/);
    expect(previewUrl(IDENTITY, 5173)).toBe(`https://${host}`);
  });

  it("stays inside a DNS label for the longest user id at the highest port", () => {
    // The label used to carry the id itself, which overflowed at 67 characters.
    const label = previewHost(USER, 65535).split(".")[0]!;
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toContain("-65535-");
  });

  it("gives different workspaces different slugs", () => {
    expect(previewIdentitySlug(IDENTITY)).not.toBe(previewIdentitySlug(USER));
    expect(previewHost(IDENTITY, 5173)).not.toBe(previewHost(USER, 5173));
  });

  it("refuses to build a URL with no domain or no key", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3630");
    expect(() => previewHost(IDENTITY, 5173)).toThrow(/PREVIEW_DOMAIN/);

    vi.stubEnv("BETTER_AUTH_URL", "https://saale.example.com");
    vi.stubEnv("SANDBOX_API_KEY", "");
    expect(() => previewHost(IDENTITY, 5173)).toThrow(/SANDBOX_API_KEY/);
  });
});

describe("reading a preview hostname", () => {
  it("recovers the workspace slug, port and token", () => {
    const host = previewHost(IDENTITY, 5173);
    const parsed = parsePreviewHost(host);

    expect(parsed).toEqual({
      slug: previewIdentitySlug(IDENTITY),
      port: 5173,
      token: host.split(".")[0]!.split("-").at(-1),
    });
  });

  it("reads the host a browser sends, with a port and a trailing dot", () => {
    const host = previewHost(IDENTITY, 5173);
    expect(parsePreviewHost(`${host}:443`)).not.toBeNull();
    expect(parsePreviewHost(`${host}.`)).not.toBeNull();
    expect(parsePreviewHost(host.toUpperCase())).not.toBeNull();
  });

  it("refuses anything that is not a preview host", () => {
    const host = previewHost(IDENTITY, 5173);
    const [label] = host.split(".");
    const token = label!.split("-").at(-1)!;

    const slug = previewIdentitySlug(IDENTITY);
    expect(parsePreviewHost("preview.saale.example.com")).toBeNull();
    expect(parsePreviewHost(`saale.example.com`)).toBeNull();
    expect(parsePreviewHost("")).toBeNull();
    // Port missing, token too short, slug not one, port out of range.
    expect(parsePreviewHost(`${slug}-${token}.preview.saale.example.com`)).toBeNull();
    expect(parsePreviewHost(`${slug}-5173-abc.preview.saale.example.com`)).toBeNull();
    expect(
      parsePreviewHost(`user-c1a2b3c4d5e6f7g8h9i0j1k2l-5173-${token}.preview.test`),
    ).toBeNull();
    expect(parsePreviewHost(`${slug}-70000-${token}.preview.saale.example.com`)).toBeNull();
  });
});
