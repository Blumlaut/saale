import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  autodiscover,
  extractBaseDomain,
  isImapBanner,
  isSmtpBanner,
  pickBestSrv,
  type DiscoveryDeps,
  type ServerConfig,
} from "@/lib/email/autodiscover";

// The helpers below are imported from the module under test on purpose: the
// previous version of this file re-declared copies of them, so it could pass
// while the real implementation drifted.

describe("extractBaseDomain", () => {
  it("extracts domain from deep subdomain MX record", () => {
    expect(extractBaseDomain("mx00.emig.gmx.net")).toBe("gmx.net");
  });

  it("handles trailing dot in FQDN", () => {
    expect(extractBaseDomain("mail.protonmail.ch.")).toBe("protonmail.ch");
  });

  it("handles simple domain", () => {
    expect(extractBaseDomain("gmail.com")).toBe("gmail.com");
  });

  it("handles deeply nested MX host", () => {
    expect(extractBaseDomain("alt1.gmail-smtp-in.l.google.com")).toBe("google.com");
  });

  it("handles single-label hostname (edge case)", () => {
    expect(extractBaseDomain("localhost")).toBe("localhost");
  });
});

describe("isImapBanner", () => {
  it("recognizes standard IMAP greeting (* OK)", () => {
    expect(isImapBanner("* OK Gimap ready for")).toBe(true);
  });

  it("recognizes Dovecot-style greeting", () => {
    expect(isImapBanner("* OK [CAPABILITY IMAP4rev2] Dovecot ready")).toBe(true);
  });

  it("recognizes IMAP keyword in banner", () => {
    expect(isImapBanner("imap.gmail.com IMAP4rev2")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isImapBanner("* ok Dovecot ready")).toBe(true);
    expect(isImapBanner("imap ready")).toBe(true);
  });

  it("rejects SMTP, HTTP and SSH banners", () => {
    expect(isImapBanner("220 smtp.example.com ESMTP")).toBe(false);
    expect(isImapBanner("HTTP/1.1 200 OK")).toBe(false);
    expect(isImapBanner("SSH-2.0-OpenSSH_9.0")).toBe(false);
    expect(isImapBanner("")).toBe(false);
  });
});

describe("isSmtpBanner", () => {
  it("recognizes standard SMTP greeting", () => {
    expect(isSmtpBanner("220 smtp.gmail.com ESMTP server ready")).toBe(true);
    expect(isSmtpBanner("220 mail.example.com")).toBe(true);
  });

  it("rejects IMAP, other SMTP codes, and 220 without a space", () => {
    expect(isSmtpBanner("* OK Gimap ready")).toBe(false);
    expect(isSmtpBanner("250 OK")).toBe(false);
    expect(isSmtpBanner("354 Start mail input")).toBe(false);
    expect(isSmtpBanner("220OK")).toBe(false);
    expect(isSmtpBanner("")).toBe(false);
  });
});

describe("pickBestSrv", () => {
  it("picks the lowest priority number", () => {
    expect(
      pickBestSrv([
        { name: "mail2.example.com", port: 993, priority: 10 },
        { name: "mail1.example.com", port: 993, priority: 5 },
        { name: "mail3.example.com", port: 993, priority: 20 },
      ]),
    ).toEqual({ host: "mail1.example.com", port: 993 });
  });

  it("strips the trailing dot from the record name", () => {
    expect(pickBestSrv([{ name: "imap.example.com.", port: 993, priority: 5 }])).toEqual({
      host: "imap.example.com",
      port: 993,
    });
  });

  it("returns null for an empty record set", () => {
    expect(pickBestSrv([])).toBeNull();
  });
});

/** Records what the discovery asked for, so tests can assert on call patterns. */
interface FakeDeps {
  srv?: Record<string, { host: string; port: number }>;
  mx?: Array<{ exchange: string; priority: number }>;
  imap?: Record<string, ServerConfig | null>;
  smtp?: Record<string, ServerConfig | null>;
  /** Extra latency per probe, to make ordering observable. */
  probeDelayMs?: number;
}

function makeDeps(config: FakeDeps) {
  const calls = {
    srv: [] as string[],
    mx: [] as string[],
    imap: [] as string[],
    smtp: [] as string[],
  };
  const delay = () => new Promise((resolve) => setTimeout(resolve, config.probeDelayMs ?? 0));

  const deps: DiscoveryDeps = {
    async lookupSrv(services, domain) {
      for (const service of services) {
        calls.srv.push(`${service}.${domain}`);
        const hit = config.srv?.[service];
        if (hit) return hit;
      }
      return null;
    },
    async resolveMx(domain) {
      calls.mx.push(domain);
      return config.mx ?? [];
    },
    async probeImap(host) {
      calls.imap.push(host);
      await delay();
      return config.imap?.[host] ?? null;
    },
    async probeSmtp(host) {
      calls.smtp.push(host);
      await delay();
      return config.smtp?.[host] ?? null;
    },
  };

  return { deps, calls };
}

const IMAP_993 = (host: string): ServerConfig => ({ host, port: 993, secure: true });
const SMTP_587 = (host: string): ServerConfig => ({ host, port: 587, secure: false });

describe("autodiscover", () => {
  beforeEach(() => {
    // Expected noise: the module logs every SRV miss / failed probe.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nothing for an address without a usable domain", async () => {
    const { deps, calls } = makeDeps({});

    expect(await autodiscover("not-an-email", { deps })).toEqual({
      imap: null,
      smtp: null,
      source: null,
    });
    expect(await autodiscover("trailing@", { deps })).toEqual({
      imap: null,
      smtp: null,
      source: null,
    });
    expect(calls.srv).toEqual([]);
    expect(calls.imap).toEqual([]);
  });

  it("uses both SRV records without probing", async () => {
    const { deps, calls } = makeDeps({
      srv: {
        "_imaps._tcp": { host: "imap.fastmail.com", port: 993 },
        "_submissions._tcp": { host: "smtp.fastmail.com", port: 465 },
      },
    });

    expect(await autodiscover("user@fastmail.com", { deps })).toEqual({
      imap: { host: "imap.fastmail.com", port: 993, secure: true },
      smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
      source: "srv",
    });
    expect(calls.imap).toEqual([]);
    expect(calls.smtp).toEqual([]);
  });

  it("takes `secure` from the SRV port, not from the record type", async () => {
    const { deps } = makeDeps({
      srv: {
        "_imaps._tcp": { host: "imap.example.com", port: 143 },
        "_submission._tcp": { host: "smtp.example.com", port: 587 },
      },
    });

    const result = await autodiscover("user@example.com", { deps });

    // 143 and 587 speak STARTTLS  reporting them as implicit TLS hangs the client.
    expect(result.imap).toEqual({ host: "imap.example.com", port: 143, secure: false });
    expect(result.smtp).toEqual({ host: "smtp.example.com", port: 587, secure: false });
    expect(result.source).toBe("srv");
  });

  it("probes for the protocol SRV did not provide and keeps the SRV source", async () => {
    const { deps, calls } = makeDeps({
      srv: { "_imaps._tcp": { host: "imap.example.com", port: 993 } },
      smtp: { "smtp.example.com": SMTP_587("smtp.example.com") },
    });

    const result = await autodiscover("user@example.com", { deps });

    expect(result.imap).toEqual(IMAP_993("imap.example.com"));
    expect(result.smtp).toEqual(SMTP_587("smtp.example.com"));
    expect(result.source).toBe("srv");
    expect(calls.imap).toEqual([]);
  });

  it("falls back to MX-derived host patterns when the domain itself answers nothing", async () => {
    const { deps, calls } = makeDeps({
      mx: [{ exchange: "mx01.protonmail.ch", priority: 10 }],
      imap: { "imap.protonmail.ch": IMAP_993("imap.protonmail.ch") },
      smtp: { "smtp.protonmail.ch": SMTP_587("smtp.protonmail.ch") },
    });

    const result = await autodiscover("user@proton.me", { deps });

    expect(result).toEqual({
      imap: IMAP_993("imap.protonmail.ch"),
      smtp: SMTP_587("smtp.protonmail.ch"),
      source: "probe",
    });
    expect(calls.imap).toContain("imap.proton.me");
    expect(calls.imap).toContain("imap.protonmail.ch");
    expect(calls.mx).toEqual(["proton.me"]);
  });

  it("prefers imap.<domain> over mail.<domain> even when mail answers first", async () => {
    const { deps } = makeDeps({
      imap: {
        "mail.example.com": IMAP_993("mail.example.com"),
        "imap.example.com": IMAP_993("imap.example.com"),
      },
    });

    const result = await autodiscover("user@example.com", { deps });

    expect(result.imap?.host).toBe("imap.example.com");
  });

  it("probes hosts and protocols concurrently instead of one after another", async () => {
    const { deps } = makeDeps({ probeDelayMs: 60 });
    const startedAt = Date.now();

    await autodiscover("user@example.com", { deps, deadlineMs: 5_000 });

    // Sequential probing would need 6 × 60ms = 360ms+ for this shape.
    expect(Date.now() - startedAt).toBeLessThan(280);
  });

  it("gives up inside the deadline when a host never answers", async () => {
    const deps: DiscoveryDeps = {
      lookupSrv: () => new Promise(() => {}),
      resolveMx: () => new Promise(() => {}),
      probeImap: () => new Promise(() => {}),
      probeSmtp: () => new Promise(() => {}),
    };
    const startedAt = Date.now();

    const result = await autodiscover("user@blackhole.example", {
      deps,
      deadlineMs: 150,
      probeTimeoutMs: 150,
    });

    expect(result).toEqual({ imap: null, smtp: null, source: null });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("survives a rejected probe and reports it instead of swallowing it", async () => {
    const deps: DiscoveryDeps = {
      lookupSrv: async () => null,
      resolveMx: async () => [],
      probeImap: async () => {
        throw new Error("ECONNREFUSED");
      },
      probeSmtp: async (host) => SMTP_587(host),
    };

    const result = await autodiscover("user@example.com", { deps, deadlineMs: 2_000 });

    // The rejected IMAP probe must not stop SMTP from being discovered; the
    // winner is the first host pattern in priority order.
    expect(result.smtp).toEqual(SMTP_587("imap.example.com"));
    expect(result.imap).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("probe of imap.example.com failed"),
      expect.any(Error),
    );
  });

  it("returns a partial result rather than guessing the other half", async () => {
    const { deps } = makeDeps({ smtp: { "smtp.example.com": SMTP_587("smtp.example.com") } });

    const result = await autodiscover("user@example.com", { deps });

    expect(result.imap).toBeNull();
    expect(result.smtp).toEqual(SMTP_587("smtp.example.com"));
    expect(result.source).toBe("probe");
  });
});
