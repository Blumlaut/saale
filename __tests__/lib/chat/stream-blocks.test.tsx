import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingMarkdown, MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { streamBlocks } from "@/lib/chat/stream-blocks";

/**
 * The streaming renderer splits a message and parses the finished part once, so
 * the one thing it must never do is render something different from what the
 * whole document renders. These tests grow a document a character at a time,
 * the way a run does, and compare the two.
 */

/** Whitespace between blocks is the one thing a split is allowed to change. */
const tidy = (html: string) => html.replace(/>\s+</g, "><");
const full = (content: string) =>
  tidy(renderToStaticMarkup(<MarkdownRenderer content={content} />));
const streamed = (content: string) =>
  tidy(renderToStaticMarkup(<StreamingMarkdown content={content} />));

/** What is done, and the block still being written. */
const split = (source: string) => {
  const blocks = streamBlocks(source);
  return { stable: blocks.slice(0, -1).join(""), tail: blocks.at(-1) ?? "" };
};

/** Every prefix of `doc`, as a run would produce them. */
function* growth(doc: string, step = 7) {
  for (let end = step; end <= doc.length; end += step) yield doc.slice(0, end);
  yield doc;
}

const DOCUMENTS: Record<string, string> = {
  paragraphs: "First line.\n\nSecond paragraph with `code`.\n\nThird **one** ends here.\n",
  headings:
    "# Title\n\nSome text.\n\n## Section\n\nMore text, and a [link](https://example.com).\n\n### Deep\n\nDone.\n",
  tightList: "Intro.\n\n- one\n- two\n- three\n\nOutro paragraph.\n",
  looseList: "Intro.\n\n- one\n\n- two\n\n- three\n\nOutro paragraph.\n",
  listWithParagraphs:
    "Steps:\n\n1. first\n\n   continued detail for the first step\n\n2. second\n\n3. third\n\nAfter the list.\n",
  nestedList: "Plan:\n\n- outer\n  - inner a\n  - inner b\n\n- outer two\n\nDone.\n",
  orderedAfterParagraph: "Here we go:\n\n1. alpha\n\n2. beta\n\n3. gamma\n\nThe end.\n",
  blockquote: "Quoted:\n\n> first line\n>\n> second line of the quote\n\nBack to prose.\n",
  lazyBlockquote: "Quoted:\n\n> first line\ncontinued lazily\n\nBack to prose.\n",
  fenced:
    "Before.\n\n```ts\nconst a = 1;\n\nexport function add(b: number) {\n  return a + b;\n}\n```\n\nAfter the fence.\n",
  unclosedFence: "Writing a file:\n\n```ts\nexport function add(a: number) {\n",
  fenceWithBlankLines: "Look:\n\n```\nline one\n\nline two\n\n\nline three\n```\n\nThat was it.\n",
  fenceThenText: "```\nx\n```\nno blank line after the fence\n\nEnd.\n",
  table: "Results:\n\n| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nMore text.\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n",
  setext: "A title\n=======\n\nAnd a subtitle\n---------------\n\nProse.\n",
  taskList: "Todos:\n\n- [ ] first\n- [x] second\n\nDone listing.\n",
  imagesAndHtmlEntities:
    "An image:\n\n![alt text](https://example.com/a.png)\n\nAmpersand &lt;tag&gt; entity.\n",
  codeSpans: "Inline `a | b` and `*stars*` stay inline.\n\nNext para.\n",
  indentedCode: "Example:\n\n    const x = 1;\n    const y = 2;\n\nProse after code.\n",
  longParagraph:
    "A long paragraph that keeps going and going, with a sentence break or two. It has more than one line\nof soft-wrapped text in the source, which markdown joins.\n\nSecond paragraph.\n",
  markdownInHtml: "<details>\n\n<summary>Summary</summary>\n\nInside details.\n\n</details>\n",
  footnotes: "A claim[^1].\n\n[^1]: the footnote\n",
  referenceLinks: "A [link][ref].\n\n[ref]: https://example.com\n",
  lazyListItem: "Todos:\n\n- item\nlazy continuation at the margin\n\n- second item\n\nEnd.\n",
  fenceInList:
    "Steps:\n\n- run the tests:\n\n  ```sh\n  npm i\n\n  npm test\n  ```\n\n- then relax\n\nDone.\n",
  blockquoteWithList: "Note:\n\n> points:\n>\n> - one\n> - two\n\nAfterwards.\n",
  hardBreaks: "A line with two trailing spaces  \nnext line.\n\nSecond paragraph.\n",
  headingAfterParagraph: "A paragraph.\n\n# Heading without a blank line after\n\nText.\n",
  startsWithFence: "```ts\nconst a = 1;\n```\n\nThen prose.\n",
  digitsInProse: "Version 1.2.3 ships in 2026. That is not a list marker.\n\nNext.\n",
};

describe("streamBlocks", () => {
  it("leaves a document whole when a definition would lose its scope", () => {
    // Rendering a block on its own would not resolve another block's definition.
    for (const doc of [DOCUMENTS.footnotes!, DOCUMENTS.referenceLinks!]) {
      expect(split(doc).stable).toBe("");
    }
  });

  it("leaves a document whole when it carries a raw HTML block", () => {
    expect(split(DOCUMENTS.markdownInHtml!).stable).toBe("");
  });

  it("splits a plain prose document before its last block", () => {
    const { stable, tail } = split(DOCUMENTS.paragraphs!);
    expect(stable).toBe("First line.\n\nSecond paragraph with `code`.\n\n");
    expect(tail).toBe("Third **one** ends here.\n");
  });

  it("keeps a list that is still growing in the tail", () => {
    // An item after a blank line joins the list above it, so the whole list has
    // to stay together.
    const { stable } = split("Intro.\n\n- one\n\n- two\n\n- thr");
    expect(stable).toBe("Intro.\n\n");
  });

  it("splits after a list that a paragraph ended", () => {
    const { stable } = split(DOCUMENTS.listWithParagraphs!);
    expect(stable).toBe(
      "Steps:\n\n1. first\n\n   continued detail for the first step\n\n2. second\n\n3. third\n\n",
    );
  });

  it("does not split inside a fenced block", () => {
    // The fence carries blank lines, so each one looks like a boundary.
    const { stable } = split("Look:\n\n```\nline one\n\nline two\n");
    expect(stable).toBe("Look:\n\n");
  });

  it("has nothing to split in a document with one block", () => {
    expect(streamBlocks("just a line\n")).toEqual(["just a line\n"]);
    expect(streamBlocks("")).toEqual([]);
    expect(split("just a line\n")).toEqual({ stable: "", tail: "just a line\n" });
  });

  it("keeps a fenced block whole, blank lines and all", () => {
    expect(streamBlocks(DOCUMENTS.fenceWithBlankLines!)).toEqual([
      "Look:\n\n",
      "```\nline one\n\nline two\n\n\nline three\n```\n\n",
      "That was it.\n",
    ]);
  });

  it("keeps the parts equal to the whole", () => {
    for (const [name, doc] of Object.entries(DOCUMENTS)) {
      for (const prefix of growth(doc, 11)) {
        const { stable, tail } = split(prefix);
        expect([name, stable + tail]).toEqual([name, prefix]);
      }
    }
  });
});

describe("StreamingMarkdown", () => {
  it("renders what the whole document renders, at every step of a run", () => {
    let splits = 0;
    for (const [name, doc] of Object.entries(DOCUMENTS)) {
      for (const prefix of growth(doc, 11)) {
        if (split(prefix).stable) splits++;
        expect([name, streamed(prefix)]).toEqual([name, full(prefix)]);
      }
    }
    // Guards the test itself: a scan that never splits would pass trivially.
    expect(splits).toBeGreaterThan(100);
  });

  it("only pays for the block being written", () => {
    // A message of many paragraphs leaves one paragraph behind per split, so the
    // part still re-rendered stays small however long the message gets.
    const doc = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i} says something about the reducer and its offsets.`,
    ).join("\n\n");

    let longestTail = 0;
    for (const prefix of growth(doc, 5)) {
      longestTail = Math.max(longestTail, split(prefix).tail.length);
    }

    expect(longestTail).toBeLessThan(200);
  });
});
