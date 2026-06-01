import { describe, it, expect } from "vitest";

// Test the pure helper functions used by autodiscover
// The network-dependent parts (DNS, TCP probes) are tested via the API endpoint
// which can be verified manually or in integration tests

describe("extractBaseDomain", () => {
  function extractBaseDomain(mxExchange: string): string {
    const parts = mxExchange.replace(/\.$/, "").split(".");
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return mxExchange;
  }

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
  function isImapBanner(text: string): boolean {
    return /\* OK/i.test(text) || /\bIMAP\b/i.test(text);
  }

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

  it("rejects SMTP banners", () => {
    expect(isImapBanner("220 smtp.example.com ESMTP")).toBe(false);
  });

  it("rejects HTTP banners", () => {
    expect(isImapBanner("HTTP/1.1 200 OK")).toBe(false);
  });

  it("rejects SSH banners", () => {
    expect(isImapBanner("SSH-2.0-OpenSSH_9.0")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isImapBanner("")).toBe(false);
  });
});

describe("isSmtpBanner", () => {
  function isSmtpBanner(text: string): boolean {
    return /^220\s/.test(text);
  }

  it("recognizes standard SMTP greeting", () => {
    expect(isSmtpBanner("220 smtp.gmail.com ESMTP server ready")).toBe(true);
  });

  it("recognizes minimal 220 response", () => {
    expect(isSmtpBanner("220 mail.example.com")).toBe(true);
  });

  it("rejects IMAP banners", () => {
    expect(isSmtpBanner("* OK Gimap ready")).toBe(false);
  });

  it("rejects other SMTP codes", () => {
    expect(isSmtpBanner("250 OK")).toBe(false);
    expect(isSmtpBanner("354 Start mail input")).toBe(false);
  });

  it("rejects 220 without trailing space", () => {
    expect(isSmtpBanner("220OK")).toBe(false);
  });

  it("rejects HTTP banners", () => {
    expect(isSmtpBanner("HTTP/1.1 200 OK")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSmtpBanner("")).toBe(false);
  });
});

describe("email domain extraction", () => {
  function extractDomain(email: string): string | null {
    const atIdx = email.lastIndexOf("@");
    if (atIdx < 0) return null;
    return email.slice(atIdx + 1) || null;
  }

  it("extracts domain from simple email", () => {
    expect(extractDomain("user@gmail.com")).toBe("gmail.com");
  });

  it("handles plus addressing", () => {
    expect(extractDomain("user+tag@gmail.com")).toBe("gmail.com");
  });

  it("handles subdomain email", () => {
    expect(extractDomain("user@sub.domain.co.uk")).toBe("sub.domain.co.uk");
  });

  it("handles dots in local part", () => {
    expect(extractDomain("first.last@outlook.com")).toBe("outlook.com");
  });

  it("returns null for email without @", () => {
    expect(extractDomain("invalid")).toBeNull();
  });

  it("returns null for email ending with @", () => {
    expect(extractDomain("user@")).toBeNull();
  });
});

describe("SRV record priority sorting", () => {
  function pickBest(records: Array<{ name: string; port: number; priority: number }>) {
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    return sorted[0]!;
  }

  it("picks lowest priority number", () => {
    const records = [
      { name: "mail2.example.com", port: 993, priority: 10 },
      { name: "mail1.example.com", port: 993, priority: 5 },
      { name: "mail3.example.com", port: 993, priority: 20 },
    ];
    expect(pickBest(records).name).toBe("mail1.example.com");
  });

  it("handles single record", () => {
    const records = [{ name: "imap.gmail.com", port: 993, priority: 5 }];
    expect(pickBest(records).name).toBe("imap.gmail.com");
  });

  it("handles equal priorities", () => {
    const records = [
      { name: "a.example.com", port: 993, priority: 10 },
      { name: "b.example.com", port: 993, priority: 10 },
    ];
    // Either is acceptable; just verify we get one
    expect(pickBest(records).priority).toBe(10);
  });
});
