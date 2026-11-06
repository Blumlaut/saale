/**
 * The frame both account mails share: the words, the button, and the escaping
 * that keeps an admin-typed instance name from breaking the markup.
 */

import { describe, expect, it } from "vitest";
import { renderAccountMail } from "@/lib/email/mail-template";

const PARTS = {
  instanceName: "Acme Console",
  heading: "Confirm this address to finish setting up your Acme Console account.",
  url: "https://saale.example.com/api/auth/reset-password/abc?callbackURL=%2Fauth%2Freset-password",
  linkLabel: "Choose a new password",
  note: "The link is good for one hour.",
};

describe("renderAccountMail", () => {
  it("reads as a sentence in the text part, with the link on its own line", () => {
    const { text } = renderAccountMail(PARTS);

    expect(text.split("\n")[0]).toBe(PARTS.heading);
    expect(text.split("\n")).toContain(PARTS.url);
    expect(text).toContain(PARTS.note);
    expect(text).toContain(PARTS.instanceName);
  });

  it("offers the link as a button and again as text", () => {
    const { html } = renderAccountMail(PARTS);

    expect(html).toContain(`<a href="${PARTS.url}"`);
    expect(html).toContain(PARTS.linkLabel);
    // Clients that drop buttons still leave the reader a link to copy.
    expect(html.split(`href="${PARTS.url}"`)).toHaveLength(3);
  });

  it("sits the button in the middle of the card", () => {
    const { html } = renderAccountMail(PARTS);

    expect(html).toContain('<p class="mail-button-row" style="margin:0 0 24px;text-align:center">');
    expect(html).toContain(`<a href="${PARTS.url}" class="mail-button"`);
  });

  it("asks the client for a dark version and repaints itself for one", () => {
    const { html } = renderAccountMail(PARTS);

    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    // The inline styles are the light theme, so every dark rule has to win over them.
    expect(html).toContain(".mail-button { background:#ff7a2e !important;");
    expect(html).toContain(".mail-page { background:#0b0b0c !important;");
  });

  it("leaves the button out when the message has nothing to link to", () => {
    const { text, html } = renderAccountMail({
      instanceName: PARTS.instanceName,
      heading: "This is a test message from your instance.",
      note: "Verification links and password resets go out through this relay.",
    });

    expect(html).not.toContain("mail-button-row");
    expect(html).not.toContain("paste this into a browser");
    expect(html).toContain("Sent by Acme Console");
    expect(text.split("\n")).toEqual([
      "This is a test message from your instance.",
      "",
      "Verification links and password resets go out through this relay.",
      "",
      "Acme Console",
    ]);
  });

  it("escapes the instance name the admin typed", () => {
    const { html } = renderAccountMail({ ...PARTS, instanceName: 'Ada & "Sons" <ltd>' });

    expect(html).toContain("Ada &amp; &quot;Sons&quot; &lt;ltd&gt;");
    expect(html).not.toContain("<ltd>");
  });

  it("escapes the link for the markup and leaves it readable in the text", () => {
    const url = "https://saale.example.com/verify?token=a&b=c";
    const { text, html } = renderAccountMail({ ...PARTS, url });

    expect(text).toContain(url);
    expect(html).toContain("token=a&amp;b=c");
  });
});
