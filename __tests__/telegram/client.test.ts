import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { convert as convertToTelegramMarkdown } from "telegram-markdown-v2";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSendMessage, mockSendPhoto, mockSendDocument, resetMessageIds } = vi.hoisted(() => {
  let nextId = 0;
  // `vi.fn()` with no arguments, implementation attached: the API calls are
  // read back out of `mock.calls` with their own tuple types.
  const make = () => {
    const fn = vi.fn();
    fn.mockImplementation(async () => ({ message_id: 1000 + nextId++ }));
    return fn;
  };
  return {
    mockSendMessage: make(),
    mockSendPhoto: make(),
    mockSendDocument: make(),
    resetMessageIds: () => (nextId = 0),
  };
});

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => value }));
vi.mock("grammy", () => ({
  Bot: class {
    api = {
      sendMessage: mockSendMessage,
      sendPhoto: mockSendPhoto,
      sendDocument: mockSendDocument,
    };
  },
  // Only the constructor matters: the upload tests read back what was handed in.
  InputFile: class {
    constructor(
      readonly data: Uint8Array,
      readonly filename?: string,
    ) {}
  },
}));

import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  splitMarkdownV2,
  splitPlainText,
} from "@/lib/telegram/message-split";
import {
  buildLinkFailureMessage,
  buildLinkRequiredMessage,
  buildLinkSuccessMessage,
  buildWebhookUrl,
  sendTelegramFile,
  sendTelegramMessage,
} from "@/lib/telegram/client";
import { TELEGRAM_FORMATTING_GUIDE } from "@/lib/telegram/prompt";

// ─── Chunk validation helpers ────────────────────────────────────────────────

/**
 * Bit per MarkdownV2 entity-toggling character (mirrors the implementation).
 */
const ENTITY_BITS: Record<string, number> = {
  "*": 1,
  _: 2,
  "`": 4,
  "|": 8,
  "[": 16,
  "]": 32,
};

/**
 * Entity parity of a chunk: non-zero means some entity span (bold/italic/
 * code/spoiler/link) is left open, which Telegram rejects with
 * "can't parse entities".
 */
function entityParity(chunk: string): number {
  let state = 0;
  let inFence = false;

  for (const line of chunk.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // fence content is literal

    let escaped = false;
    for (const ch of line) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        const bit = ENTITY_BITS[ch];
        if (bit !== undefined) state ^= bit;
      }
    }
  }

  return state;
}

function fenceLineCount(chunk: string): number {
  return chunk.split("\n").filter((line) => line.trim().startsWith("```")).length;
}

function trailingBackslashRun(chunk: string): number {
  let n = 0;
  while (n < chunk.length && chunk[chunk.length - 1 - n] === "\\") n++;
  return n;
}

/**
 * Assert every chunk is acceptable to Telegram: fits the limit, has no open
 * entity spans, no unclosed code fence, and no dangling escape at the end.
 */
function assertValidChunks(chunks: string[], maxLength = TELEGRAM_MAX_MESSAGE_LENGTH): void {
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(maxLength);
    expect(entityParity(chunk)).toBe(0);
    expect(fenceLineCount(chunk) % 2).toBe(0);
    expect(trailingBackslashRun(chunk) % 2).toBe(0);
  }
}

// ─── splitPlainText ──────────────────────────────────────────────────────────

describe("splitPlainText", () => {
  it("returns single chunk for short messages", () => {
    expect(splitPlainText("Hello, world!")).toEqual(["Hello, world!"]);
  });

  it("splits at word boundaries for long messages without losing words", () => {
    const words = Array.from({ length: 1500 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const result = splitPlainText(text);

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    // No word lost: removing all whitespace from both sides must match
    expect(result.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("force splits when no space found", () => {
    const result = splitPlainText("a".repeat(5000));
    expect(result).toEqual(["a".repeat(4096), "a".repeat(904)]);
  });

  it("splits at newline when no space found", () => {
    const result = splitPlainText("a".repeat(3000) + "\n" + "b".repeat(2000));
    expect(result).toHaveLength(2);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
  });

  it("handles empty string", () => {
    expect(splitPlainText("")).toEqual([""]);
  });

  it("handles exact length message", () => {
    const text = "a".repeat(4096);
    expect(splitPlainText(text)).toEqual([text]);
  });
});

// ─── splitMarkdownV2 ─────────────────────────────────────────────────────────

describe("splitMarkdownV2", () => {
  it("returns single chunk for text at or under the limit", () => {
    expect(splitMarkdownV2("Hello *world*")).toEqual(["Hello *world*"]);
    const exact = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(splitMarkdownV2(exact)).toEqual([exact]);
  });

  it("splits at line boundaries and restores content exactly", () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(`Paragraph ${i} with some *emphasis* and \`code\` and more text.`);
      lines.push("");
    }
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitMarkdownV2(text);
    assertValidChunks(chunks);
    expect(chunks.length).toBeGreaterThan(1);
    // Line-boundary split: dropping one newline per boundary is the only
    // mutation, so rejoining with "\n" restores the input exactly.
    expect(chunks.join("\n")).toBe(text);
  });

  it("does not split inside an entity span that crosses lines", () => {
    const text = [
      "A".repeat(2000), // paragraph 1
      "",
      `*${"B".repeat(2000)}`, // bold opens
      "tail*", // bold closes  a naive 4096 cut lands in here
      "",
      "C".repeat(2000), // paragraph 2
    ].join("\n");
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitMarkdownV2(text);
    assertValidChunks(chunks);
    expect(chunks.join("\n")).toBe(text);
    // The whole bold span must live in one chunk
    const boldChunks = chunks.filter((c) => c.includes("*"));
    expect(boldChunks).toHaveLength(1);
    expect(boldChunks[0]).toContain(`*${"B".repeat(2000)}\ntail*`);
  });

  it("never splits inside a fenced code block", () => {
    const fenceContent = Array.from(
      { length: 60 },
      (_, i) => `code line ${i} with *literal* | chars \\and backslashes`,
    ).join("\n");
    // Fence (~3.1k) fits in one chunk on its own, but the whole document
    // exceeds the limit, so chunk boundaries must land around the fence.
    const text = ["I".repeat(1000), "", "```", fenceContent, "```", "", "O".repeat(1000)].join(
      "\n",
    );
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitMarkdownV2(text);
    assertValidChunks(chunks);
    // The fence is atomic: it sits whole inside exactly one chunk
    const fenceChunks = chunks.filter((c) => c.includes("```"));
    expect(fenceChunks).toHaveLength(1);
    expect(fenceChunks[0]).toContain("```\n" + fenceContent + "\n```");
    expect(chunks.join("\n")).toBe(text);
  });

  it("re-wraps a code fence that alone exceeds the limit", () => {
    const fenceContent = Array.from(
      { length: 120 },
      (_, i) => `line_${i} with some *literal* | content`,
    ).join("\n");
    const text = ["intro", "", "```", fenceContent, "```", "", "outro"].join("\n");

    const chunks = splitMarkdownV2(text);
    assertValidChunks(chunks);

    // Each re-wrapped piece is a complete fenced block
    const fenceChunks = chunks.filter((c) => c.includes("```"));
    expect(fenceChunks.length).toBeGreaterThan(1);
    for (const chunk of fenceChunks) {
      expect(chunk.startsWith("```")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }

    // No fence content line lost
    const all = chunks.join("\n");
    for (const line of fenceContent.split("\n")) {
      expect(all).toContain(line);
    }
  });

  it("hard-splits a single line longer than the limit", () => {
    const chunks = splitMarkdownV2("a".repeat(5000));
    assertValidChunks(chunks);
    expect(chunks).toEqual(["a".repeat(4096), "a".repeat(904)]);
  });

  it("hard-splits a long wordy line at word boundaries", () => {
    const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitMarkdownV2(text);
    assertValidChunks(chunks);
    expect(chunks.length).toBe(2);
    // All words survive
    expect(chunks.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("handles empty and near-empty text", () => {
    expect(splitMarkdownV2("")).toEqual([""]);
    expect(splitMarkdownV2("\n")).toEqual(["\n"]);
  });
});

// ─── Regression: escape bloat (the "message is too long" bug) ────────────────

/**
 * Build a realistic note in the style of the production failure: dense with
 * dots, backticks, backslashes and dashes  characters the MarkdownV2
 * converter escapes with backslashes, inflating the output well beyond the
 * raw length.
 */
function buildEscapeDenseNote(): string {
  const lines: string[] = [
    "Three notes  all updates to pre-existing notes. Exact wording as stored:",
    "",
    '*1. "Config & Credentials" (category: credentials)*',
    "",
    "> *API auth*: Bearer token in `config.json`",
    "> •   Token: `8c30aadf398d97b3e8931c68a01e8f17ce6304d6765ca237ac2226f544cc2be5`",
  ];

  for (let i = 0; i < 55; i++) {
    lines.push(
      `> + setting_${i}: host 0.0.0.0, port ${9100 + i}, allowlist [${i}, ${i + 1}], probeDelaysMs [2000, 5000, 10000]`,
      `> + rotate with: node src\\cli.js rotate-token --config "C:\\path\\config_${i}.json"`,
    );
  }

  return lines.join("\n");
}

describe("escape bloat regression", () => {
  it("splits converted output so escaping can never push a chunk over the limit", () => {
    const raw = buildEscapeDenseNote();
    const converted = convertToTelegramMarkdown(raw, "escape");

    // Preconditions proving the bug: converted text is longer than a single
    // message, and escaping a raw 4096-char slice (what the old code did
    // split raw, convert per chunk) already overflows the limit.
    expect(converted.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(converted.length - raw.length).toBeGreaterThan(300);
    expect(
      convertToTelegramMarkdown(raw.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH), "escape").length,
    ).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

    const chunks = splitMarkdownV2(converted);
    assertValidChunks(chunks);
    expect(chunks.length).toBeGreaterThan(1);

    // Line-boundary split: full content preserved, in order
    expect(chunks.join("\n")).toBe(converted);
  });
});

// ─── sendTelegramMessage ─────────────────────────────────────────────────────

describe("sendTelegramMessage", () => {
  beforeEach(() => {
    // mockClear keeps the hoisted implementation, resets call history and IDs
    mockSendMessage.mockClear();
    resetMessageIds();
  });

  it("converts markdown and sends a short message in one call", async () => {
    const ids = await sendTelegramMessage("tok", BigInt(123), "Hello *world*");

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, params] = mockSendMessage.mock.calls[0] as [
      number,
      string,
      Record<string, unknown>,
    ];
    expect(chatId).toBe(123);
    expect(text).toBe(convertToTelegramMarkdown("Hello *world*", "escape"));
    expect(params.parse_mode).toBe("MarkdownV2");
    expect(ids).toEqual([1000]);
  });

  it("splits long messages so every chunk fits the 4096 limit and none is lost", async () => {
    const raw = buildEscapeDenseNote();
    const ids = await sendTelegramMessage("tok", BigInt(123), raw);

    expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(ids).toHaveLength(mockSendMessage.mock.calls.length);

    for (const [, text] of mockSendMessage.mock.calls as [number, string][]) {
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }

    // Full converted content delivered in order, nothing lost
    const sent = (mockSendMessage.mock.calls as [number, string][]).map((c) => c[1]).join("\n");
    expect(sent).toBe(convertToTelegramMarkdown(raw, "escape"));
  });

  it("only attaches the reply parameter to the first chunk", async () => {
    await sendTelegramMessage("tok", BigInt(123), buildEscapeDenseNote(), { replyToMessageId: 42 });

    expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
    const firstParams = mockSendMessage.mock.calls[0]![2] as Record<string, unknown>;
    expect(firstParams.reply_parameters).toEqual({ message_id: 42 });

    for (let i = 1; i < mockSendMessage.mock.calls.length; i++) {
      const params = mockSendMessage.mock.calls[i]![2] as Record<string, unknown>;
      expect(params.reply_parameters).toBeUndefined();
    }
  });

  it("passes HTML text through unconverted and splits it plainly", async () => {
    const text = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
    await sendTelegramMessage("tok", BigInt(123), text, { parseMode: "HTML" });

    const calls = mockSendMessage.mock.calls as [number, string, Record<string, unknown>][];
    expect(calls.length).toBeGreaterThan(1);
    for (const [, sent, params] of calls) {
      expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
      expect(params.parse_mode).toBe("HTML");
    }
    // Unconverted: no MarkdownV2 escaping introduced
    expect(
      calls
        .map((c) => c[1])
        .join("")
        .replace(/\s+/g, ""),
    ).toBe(text.replace(/\s+/g, ""));
  });
});

// ─── sendTelegramFile ────────────────────────────────────────────────────────

/** An upload as `sendTelegramFile` hands it to the API. */
interface UploadCall {
  chat: number;
  input: { data: Uint8Array; filename?: string };
  params: { caption?: string };
}

function uploadCall(mock: { mock: { calls: unknown[] } }, index = 0): UploadCall {
  const [chat, input, params] = mock.mock.calls[index] as [
    number,
    { data: Uint8Array; filename?: string },
    { caption?: string },
  ];
  return { chat, input, params };
}

describe("sendTelegramFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMessageIds();
  });

  it("uploads an image as a photo, which Telegram renders inline", async () => {
    const id = await sendTelegramFile("tok", BigInt(123), {
      fileName: "chart.png",
      mimeType: "image/png",
      buffer: new Uint8Array([0x89, 0x50]),
    });

    expect(mockSendDocument).not.toHaveBeenCalled();
    const call = uploadCall(mockSendPhoto);
    expect(call.chat).toBe(123);
    expect(call.input.filename).toBe("chart.png");
    expect(call.params.caption).toBeUndefined();
    expect(id).toBe(1000);
  });

  it("sends every other type as a document, whatever the extension", async () => {
    for (const file of [
      { fileName: "report.pdf", mimeType: "application/pdf" },
      { fileName: "model.gguf", mimeType: "application/octet-stream" },
      { fileName: "archive.tar.zst", mimeType: "" },
      { fileName: "diagram.svg", mimeType: "image/svg+xml" },
    ]) {
      mockSendDocument.mockClear();
      await sendTelegramFile("tok", BigInt(123), { ...file, buffer: new Uint8Array([1, 2]) });

      expect(mockSendPhoto).not.toHaveBeenCalled();
      expect(uploadCall(mockSendDocument).input.filename).toBe(file.fileName);
    }
  });

  it("carries the caption over with the file", async () => {
    await sendTelegramFile(
      "tok",
      BigInt(123),
      { fileName: "q3.pdf", mimeType: "application/pdf", buffer: new Uint8Array([1]) },
      { caption: "  Quarterly numbers  " },
    );

    expect(uploadCall(mockSendDocument).params.caption).toBe("Quarterly numbers");
  });

  it("truncates a caption Telegram would reject along with the file", async () => {
    await sendTelegramFile(
      "tok",
      BigInt(123),
      { fileName: "q3.pdf", mimeType: "application/pdf", buffer: new Uint8Array([1]) },
      { caption: "x".repeat(2000) },
    );

    expect(uploadCall(mockSendDocument).params.caption).toHaveLength(1024);
  });

  it("falls back to a document when Telegram refuses the photo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSendPhoto.mockRejectedValueOnce(new Error("Bad Request: PHOTO_INVALID_DIMENSIONS"));

    const id = await sendTelegramFile("tok", BigInt(123), {
      fileName: "panorama.png",
      mimeType: "image/png",
      buffer: new Uint8Array([0x89]),
    });

    const call = uploadCall(mockSendDocument);
    expect(call.input.filename).toBe("panorama.png");
    expect(id).toBe(1000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("lets a rejection from the document upload reach the caller", async () => {
    mockSendDocument.mockRejectedValueOnce(new Error("Bad Request: file is too big"));

    await expect(
      sendTelegramFile("tok", BigInt(123), {
        fileName: "huge.bin",
        mimeType: "application/octet-stream",
        buffer: new Uint8Array([1]),
      }),
    ).rejects.toThrow("file is too big");
  });
});

// ─── Linking messages ────────────────────────────────────────────────────────

describe("buildWebhookUrl", () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it.each([
    { envVar: "NGROK_URL", value: "https://abc123.ngrok.io" },
    { envVar: "VERCEL_URL", value: "myapp.vercel.app" },
    { envVar: "NEXT_PUBLIC_BASE_URL", value: "https://saale.example.com" },
    { envVar: "APP_URL", value: "http://localhost:3000" },
  ])("uses $envVar when set", ({ envVar, value }) => {
    delete process.env.NGROK_URL;
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.APP_URL;
    process.env[envVar] = value;

    // One shared bot means one webhook path  it names the instance, not a user.
    expect(buildWebhookUrl()).toBe(
      `${envVar === "VERCEL_URL" ? "https://" : ""}${value}/api/integrations/telegram/webhook`,
    );
  });

  it("prefers NGROK_URL over VERCEL_URL", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.APP_URL;
    process.env.NGROK_URL = "https://ngrok.test";
    process.env.VERCEL_URL = "vercel.test";

    expect(buildWebhookUrl()).toBe("https://ngrok.test/api/integrations/telegram/webhook");
  });

  it("falls back to localhost when no env is set", () => {
    delete process.env.NGROK_URL;
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.APP_URL;

    expect(buildWebhookUrl()).toBe("http://localhost:3630/api/integrations/telegram/webhook");
  });
});

describe("buildLinkRequiredMessage", () => {
  it("sends an unlinked sender to the linking screen, not to a bot owner", () => {
    const msg = buildLinkRequiredMessage();

    expect(msg).toContain("Settings");
    expect(msg).toContain("Integrations");
    // There is no owner to whitelist anyone any more.
    expect(msg).not.toMatch(/whitelist|authorized/i);
  });
});

describe("buildLinkSuccessMessage", () => {
  it("confirms the account is connected", () => {
    const msg = buildLinkSuccessMessage();
    expect(msg).toContain("Linked");
  });
});

describe("buildLinkFailureMessage", () => {
  it("explains an expired or unknown code", () => {
    const msg = buildLinkFailureMessage("expired");
    expect(msg).toMatch(/invalid or has expired/);
    expect(msg).toContain("Integrations");
  });

  it("tells someone whose Telegram account is taken by another user what to do", () => {
    const msg = buildLinkFailureMessage("already_linked");
    expect(msg).toMatch(/already linked to a different Saale account/);
    expect(msg).toMatch(/Unlink/);
  });
});

// ─── Formatting guide ────────────────────────────────────────────────────────

describe("TELEGRAM_FORMATTING_GUIDE", () => {
  it("instructs the model to use Markdown, not HTML", () => {
    expect(TELEGRAM_FORMATTING_GUIDE).toContain("**bold**");
    expect(TELEGRAM_FORMATTING_GUIDE).toMatch(/Never use HTML tags/);
    // Regression: the old guide told the model to emit <b>/<i> tags, which the
    // MarkdownV2 sender escapes and ships as literal text.
    expect(TELEGRAM_FORMATTING_GUIDE).not.toMatch(/Use HTML formatting/);
  });
});
