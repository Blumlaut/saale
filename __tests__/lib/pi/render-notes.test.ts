import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  appendCustomMessageEntry: vi.fn(),
  sendCustomMessage: vi.fn(),
  continueRecent: vi.fn(),
  pooled: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { continueRecent: hoisted.continueRecent },
}));
vi.mock("@/lib/pi/agent-pool", () => ({
  get: hoisted.pooled,
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  getSessionDir: (userId: string, sessionId: string) =>
    `/uploads/pi_sessions/${userId}/${sessionId}`,
}));
vi.mock("@/lib/db", () => ({
  prisma: { chatMessage: { findMany: hoisted.findMany } },
}));

import {
  appendRenderNote,
  RENDER_NOTE_TYPE,
  renderNoteText,
  seedRenderNotes,
} from "@/lib/pi/render-notes";

const note = {
  userId: "user-1",
  sessionId: "session-1",
  command: "image" as const,
  sentence: 'Rendered "a red fox" with Flux (1024×768). Saved to generated/fox.webp.',
};

/** A transcript manager stub: what the note path reads and writes. */
function manager(entryCount = 1) {
  return {
    getEntryCount: () => entryCount,
    appendCustomMessageEntry: hoisted.appendCustomMessageEntry,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.continueRecent.mockReturnValue(manager());
  hoisted.findMany.mockResolvedValue([]);
});

describe("a render's note", () => {
  it("says which command made the picture, and what it rendered", () => {
    expect(renderNoteText({ command: "image", sentence: note.sentence })).toBe(
      `[/image] ${note.sentence}`,
    );
  });

  it("names the pictures an edit worked from, in order", () => {
    expect(
      renderNoteText({
        command: "edit",
        sentence: 'Edited "make it night" with Qwen (1024×1024).',
        sources: ["uploads/cat.png", "uploads/garden.png"],
      }),
    ).toBe(
      '[/edit] Edited "make it night" with Qwen (1024×1024).\n' +
        "Worked from: uploads/cat.png, uploads/garden.png.",
    );
  });
});

describe("appendRenderNote", () => {
  it("writes the note into the chat's transcript", async () => {
    await appendRenderNote(note);

    expect(hoisted.continueRecent).toHaveBeenCalledWith(
      "/uploads/pi_sessions/user-1/session-1",
      "/uploads/pi_sessions/user-1/session-1",
    );
    // `false` keeps it out of the TUI's display; the web reads the DB.
    expect(hoisted.appendCustomMessageEntry).toHaveBeenCalledWith(
      RENDER_NOTE_TYPE,
      `[/image] ${note.sentence}`,
      false,
    );
  });

  // A second manager over the same file would leave the loaded session without
  // the note, and a run in flight must not get a user message in the middle of
  // a tool call, so the live session's own queue takes it.
  it("hands the note to the live session when the chat has one pooled", async () => {
    hoisted.pooled.mockReturnValue({ session: { sendCustomMessage: hoisted.sendCustomMessage } });

    await appendRenderNote(note);

    expect(hoisted.continueRecent).not.toHaveBeenCalled();
    expect(hoisted.sendCustomMessage).toHaveBeenCalledWith(
      { customType: RENDER_NOTE_TYPE, content: `[/image] ${note.sentence}`, display: false },
      { triggerTurn: false },
    );
  });
});

describe("seedRenderNotes", () => {
  /** The stored result a render card carries: the sentence, then its metadata. */
  function renderResult(sentence: string, path = "generated/fox.webp"): string {
    return `${sentence}\n${JSON.stringify({
      _saaleImageMeta: {
        path,
        model: "flux",
        provider: "openrouter",
        prompt: "a red fox",
        width: 1024,
        height: 768,
      },
    })}`;
  }

  it("notes what the chat rendered while its transcript was empty", async () => {
    const sentences = [
      'Rendered "a red fox" with Flux (1024×768). Saved to generated/fox.webp and shown to the user.',
      'Edited "make it night" with Qwen (1024×1024). Saved to generated/night.webp and shown to the user.',
    ];
    hoisted.findMany.mockResolvedValue([
      {
        toolCalls: JSON.stringify([
          {
            name: "generate_image",
            args: { prompt: "a red fox" },
            result: renderResult(sentences[0]!),
          },
        ]),
      },
      {
        toolCalls: JSON.stringify([
          {
            name: "edit_image",
            args: { prompt: "make it night", images: ["uploads/fox.webp"] },
            result: renderResult(sentences[1]!, "generated/night.webp"),
          },
        ]),
      },
    ]);

    const empty = manager(0);
    await seedRenderNotes({ sessionId: "session-1", sessionManager: empty as never });

    expect(hoisted.appendCustomMessageEntry.mock.calls).toEqual([
      [RENDER_NOTE_TYPE, `[/image] ${sentences[0]}`, false],
      [RENDER_NOTE_TYPE, `[/edit] ${sentences[1]}\nWorked from: uploads/fox.webp.`, false],
    ]);
  });

  it("leaves a transcript that already holds a conversation alone", async () => {
    const started = manager(4);

    await seedRenderNotes({ sessionId: "session-1", sessionManager: started as never });

    expect(hoisted.findMany).not.toHaveBeenCalled();
    expect(hoisted.appendCustomMessageEntry).not.toHaveBeenCalled();
  });

  it("skips a message that rendered nothing", async () => {
    hoisted.findMany.mockResolvedValue([
      { toolCalls: JSON.stringify([{ name: "read", args: { path: "notes.txt" }, result: "hi" }]) },
      { toolCalls: null },
    ]);

    await seedRenderNotes({ sessionId: "session-1", sessionManager: manager(0) as never });

    expect(hoisted.appendCustomMessageEntry).not.toHaveBeenCalled();
  });
});
