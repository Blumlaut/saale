import { describe, it, expect } from "vitest";
import {
  sanitizePostgresString,
  parseAddresses,
  formatMessageDate,
  senderLabel,
  splitEmailAddresses,
} from "@/lib/email/utils";

describe("sanitizePostgresString", () => {
  it("strips null bytes from strings", () => {
    expect(sanitizePostgresString("hello\x00world")).toBe("helloworld");
    expect(sanitizePostgresString("\x00start")).toBe("start");
    expect(sanitizePostgresString("end\x00")).toBe("end");
    expect(sanitizePostgresString("a\x00b\x00c")).toBe("abc");
  });

  it("returns null for null inputs", () => {
    expect(sanitizePostgresString(null)).toBeNull();
  });

  it("returns null for undefined inputs", () => {
    expect(sanitizePostgresString(undefined)).toBeNull();
  });

  it("returns null for boolean false", () => {
    expect(sanitizePostgresString(false)).toBeNull();
  });

  it("passes through normal strings unchanged", () => {
    expect(sanitizePostgresString("hello world")).toBe("hello world");
    expect(sanitizePostgresString("")).toBe("");
    expect(sanitizePostgresString("café")).toBe("café");
  });

  it("converts non-string types to string", () => {
    expect(sanitizePostgresString(42)).toBe("42");
    expect(sanitizePostgresString(true)).toBe("true");
  });
});

describe("parseAddresses", () => {
  it("returns array input filtered of falsy values", () => {
    expect(parseAddresses(["a@b.com", "c@d.com"])).toEqual(["a@b.com", "c@d.com"]);
    expect(parseAddresses(["a@b.com", "", null, "c@d.com"])).toEqual(["a@b.com", "c@d.com"]);
  });

  it("parses JSON string containing array", () => {
    expect(parseAddresses('["a@b.com", "c@d.com"]')).toEqual(["a@b.com", "c@d.com"]);
  });

  it("parses JSON string containing single string", () => {
    expect(parseAddresses('"a@b.com"')).toEqual(["a@b.com"]);
  });

  it("returns plain string as single-element array", () => {
    expect(parseAddresses("a@b.com")).toEqual(["a@b.com"]);
  });

  it("returns empty array for empty or nullish input", () => {
    expect(parseAddresses("")).toEqual([]);
    expect(parseAddresses(null)).toEqual([]);
    expect(parseAddresses(undefined)).toEqual([]);
  });
});

describe("splitEmailAddresses", () => {
  it("splits comma-separated addresses", () => {
    expect(splitEmailAddresses("a@b.com, c@d.com")).toEqual(["a@b.com", "c@d.com"]);
  });

  it("trims whitespace", () => {
    expect(splitEmailAddresses(" a@b.com ,  c@d.com ")).toEqual(["a@b.com", "c@d.com"]);
  });

  it("filters empty entries", () => {
    expect(splitEmailAddresses("a@b.com,,c@d.com,")).toEqual(["a@b.com", "c@d.com"]);
  });

  it("handles single address", () => {
    expect(splitEmailAddresses("a@b.com")).toEqual(["a@b.com"]);
  });

  it("returns empty array for empty input", () => {
    expect(splitEmailAddresses("")).toEqual([]);
    expect(splitEmailAddresses(", , ,")).toEqual([]);
  });
});

describe("senderLabel", () => {
  it("prefers the name, then the address, then a placeholder", () => {
    expect(senderLabel({ fromName: "Ada", fromEmail: "ada@example.com" })).toBe("Ada");
    expect(senderLabel({ fromName: null, fromEmail: "ada@example.com" })).toBe("ada@example.com");
    expect(senderLabel({ fromName: null, fromEmail: null })).toBe("Unknown Sender");
  });
});

describe("formatMessageDate", () => {
  it("writes the date and time the way the mail views show it", () => {
    expect(formatMessageDate("2026-03-01T10:05:00.000Z")).toMatch(/Mar 1, 2026 at \d{1,2}:05/);
    expect(formatMessageDate(new Date(2026, 2, 1, 10, 5))).toBe("Mar 1, 2026 at 10:05 AM");
  });
});
