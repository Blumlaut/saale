import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePreviewHost,
  previewConfig,
  previewHost,
  PREVIEW_PLACEHOLDER_DOMAIN,
  previewSetup,
  previewUrl,
} from "@/lib/preview/url";

const KEY = "0123456789abcdef0123456789abcdef";
// A user identity is `user-` and a 25 character cuid: the longest label case.
const USER = "user-c1234567890123456789012ab";
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
  it("carries the identity, the port and a signature, inside one DNS label", () => {
    const host = previewHost(IDENTITY, 5173);
    const [label, ...rest] = host.split(".");

    expect(rest.join(".")).toBe("preview.saale.example.com");
    expect(label).toMatch(/^user-c1a2b3c4d5e6f7g8h9i0j1k2l-5173-[0-9a-f]{24}$/);
    expect(label!.length).toBeLessThanOrEqual(63);
    expect(previewUrl(IDENTITY, 5173)).toBe(`https://${host}`);
  });

  it("fits the longest identity a user id can produce", () => {
    const label = previewHost(USER, 5173).split(".")[0]!;
    expect(label.length).toBeLessThanOrEqual(63);
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
  it("recovers the identity, port and token", () => {
    const host = previewHost(IDENTITY, 5173);
    const parsed = parsePreviewHost(host);

    expect(parsed).toEqual({
      identity: IDENTITY,
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

    expect(parsePreviewHost("preview.saale.example.com")).toBeNull();
    expect(parsePreviewHost(`saale.example.com`)).toBeNull();
    expect(parsePreviewHost("")).toBeNull();
    // Port missing, token too short, identity not one.
    expect(
      parsePreviewHost(`user-c1a2b3c4d5e6f7g8h9i0j1k2l-${token}.preview.saale.example.com`),
    ).toBeNull();
    expect(
      parsePreviewHost(`user-c1a2b3c4d5e6f7g8h9i0j1k2l-5173-abc.preview.saale.example.com`),
    ).toBeNull();
    expect(parsePreviewHost(`someone-5173-${token}.preview.saale.example.com`)).toBeNull();
    expect(
      parsePreviewHost(`user-c1a2b3c4d5e6f7g8h9i0j1k2l-70000-${token}.preview.saale.example.com`),
    ).toBeNull();
  });
});

describe("the setup block", () => {
  it("is filled in with this deployment's domain", () => {
    const setup = previewSetup();

    expect(setup.domain).toBe("preview.saale.example.com");
    expect(setup.probeUrl).toBe("https://probe.preview.saale.example.com/__preview/health");
    expect(setup.nginx).toContain("server_name *.preview.saale.example.com;");
    expect(setup.nginx).toContain("proxy_pass http://127.0.0.1:8101;");
    expect(setup.nginx).toContain("proxy_set_header Host $host;");
  });

  it("still shows a block, filled in with a placeholder, while previews are off", () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3630");

    const setup = previewSetup();
    expect(setup.domain).toBe(PREVIEW_PLACEHOLDER_DOMAIN);
    expect(setup.probeUrl).toBeNull();
    expect(setup.nginx).toContain(`server_name *.${PREVIEW_PLACEHOLDER_DOMAIN};`);
  });
});
