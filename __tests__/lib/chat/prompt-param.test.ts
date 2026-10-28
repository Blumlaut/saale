import { describe, it, expect } from "vitest";
import { decodePromptEntities, PROMPT_PARAM, readPromptParam } from "@/lib/chat/prompt-param";

/**
 * Firefox's sidebar chatbot sends its prompt in `?q=`, with the page's selection
 * and URL escaped inside the prompt. What lands in the composer is what the
 * agent reads, so the escaping has to come off and nothing else with it.
 */

describe("readPromptParam", () => {
  it("reads a selection prompt the way Firefox composes it", () => {
    // "I'm on page "Composer" with "<selection>a & b</selection>" selected."
    const q =
      "I%E2%80%99m%20on%20page%20%E2%80%9CComposer%E2%80%9D%20with%20%E2%80%9C%3Cselection%3Ea%20%26amp%3B%20b%3C%2Fselection%3E%E2%80%9D%20selected.%0A%0APlease%20explain%20the%20key%20concepts.";

    expect(readPromptParam(decodeURIComponent(q))).toBe(
      "I’m on page “Composer” with “<selection>a & b</selection>” selected.\n\nPlease explain the key concepts.",
    );
  });

  it("keeps a page prompt's URL intact", () => {
    const q =
      "Please summarize the webpage at <pageUrl>https://example.com/a?b=1&amp;c=2</pageUrl> using precise and concise language.";

    expect(readPromptParam(q)).toContain("<pageUrl>https://example.com/a?b=1&c=2</pageUrl>");
  });

  it("has nothing to send for an empty or missing prompt", () => {
    expect(readPromptParam(null)).toBeNull();
    expect(readPromptParam(undefined)).toBeNull();
    expect(readPromptParam("")).toBeNull();
    expect(readPromptParam("   \n\t ")).toBeNull();
    expect(readPromptParam("\0")).toBeNull();
  });
});

describe("decodePromptEntities", () => {
  it("decodes the named and numeric escapes Firefox writes", () => {
    expect(decodePromptEntities("&lt;b&gt; &quot;x&quot; &#39;y&#39; &#x41;")).toBe(
      "<b> \"x\" 'y' A",
    );
  });

  it("leaves text that is not an escape alone", () => {
    const text = "a & b, 1 < 2, AT&T, &#x110000;, &unknown;";

    expect(decodePromptEntities(text)).toBe(text);
  });
});

describe("PROMPT_PARAM", () => {
  it("is the parameter Firefox appends to the provider URL", () => {
    expect(PROMPT_PARAM).toBe("q");
  });
});
