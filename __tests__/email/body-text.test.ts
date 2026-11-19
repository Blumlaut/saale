import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { emailBodyText } from "@/lib/email/body-text";

/** A marketing mail: multipart/alternative with nothing but an html part. */
function htmlOnlyMail(html: string): string {
  return [
    "From: TIDAL <no-reply@tidal.com>",
    "To: me@example.com",
    "Subject: Dein Preis ändert sich",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--BOUND--",
    "",
  ].join("\r\n");
}

describe("emailBodyText", () => {
  it("keeps the text part when it has content", () => {
    expect(emailBodyText({ text: "Hallo Max,\n\ndein Abo kostet 12,99 Euro.", html: null })).toBe(
      "Hallo Max,\n\ndein Abo kostet 12,99 Euro.",
    );
  });

  it("converts the html part when the text part is only whitespace", () => {
    const body = emailBodyText({ text: "\n  \n", html: "<p>Dein Abo kostet 12,99 Euro.</p>" });
    expect(body).toBe("Dein Abo kostet 12,99 Euro.");
  });

  it("converts the html part when the message has no text part at all", async () => {
    const parsed = await simpleParser(
      htmlOnlyMail("<h1>Dein Preis ändert sich</h1><p>Ab Januar 12,99 Euro.</p>"),
    );
    expect(parsed.text).toBeUndefined();

    const body = emailBodyText({ text: parsed.text, html: parsed.html });
    expect(body).toContain("DEIN PREIS ÄNDERT SICH");
    expect(body).toContain("Ab Januar 12,99 Euro.");
  });

  it("returns null when the body has no content either way", () => {
    expect(emailBodyText({ text: null, html: null })).toBeNull();
    expect(emailBodyText({ text: "   ", html: "<p> </p>" })).toBeNull();
  });
});
