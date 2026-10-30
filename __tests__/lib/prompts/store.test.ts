import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    prompt: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import * as db from "@/lib/db";
import {
  createPrompt,
  deletePrompt,
  normalizePromptInput,
  serializePrompt,
  updatePrompt,
  type PromptInput,
} from "@/lib/prompts/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrompt = db.prisma.prompt as any;

const VALID: PromptInput = {
  name: "review",
  description: "Review the staged changes",
  argumentHint: "[focus]",
  scope: "coder",
  content: "Review the staged changes.",
};

function row(overrides = {}) {
  return {
    id: "prompt-1",
    userId: "user-1",
    ...VALID,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizePromptInput", () => {
  it("folds the name to lowercase and trims every field", () => {
    const result = normalizePromptInput({
      name: "  Review  ",
      description: " Review the staged changes ",
      argumentHint: " [focus] ",
      scope: "coder",
      content: " Review the staged changes. ",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "review",
        description: "Review the staged changes",
        argumentHint: "[focus]",
        scope: "coder",
        content: "Review the staged changes.",
      },
    });
  });

  it("turns an empty argument hint into null and defaults the scope", () => {
    const result = normalizePromptInput({
      name: "digest",
      description: "Summarise the inbox",
      argumentHint: "  ",
      content: "Summarise the inbox.",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "digest",
        description: "Summarise the inbox",
        argumentHint: null,
        scope: "any",
        content: "Summarise the inbox.",
      },
    });
  });

  it("refuses a name a built-in command owns", () => {
    const result = normalizePromptInput({ ...VALID, name: "compact" });
    expect(result).toEqual({
      ok: false,
      error: "/compact is a built-in command. Pick another name.",
    });
  });

  it("refuses a name the slash parser cannot read", () => {
    for (const name of ["has space", "with/slash", "UPPER ok lower", "..."]) {
      expect(normalizePromptInput({ ...VALID, name }).ok).toBe(false);
    }
  });

  it("requires a description and a prompt", () => {
    expect(normalizePromptInput({ ...VALID, description: " " }).ok).toBe(false);
    expect(normalizePromptInput({ ...VALID, content: " " }).ok).toBe(false);
  });

  it("refuses an unknown scope", () => {
    expect(normalizePromptInput({ ...VALID, scope: "everything" }).ok).toBe(false);
  });

  it("refuses a body that is not an object", () => {
    expect(normalizePromptInput(null).ok).toBe(false);
    expect(normalizePromptInput({}).ok).toBe(false);
  });
});

describe("serializePrompt", () => {
  it("exposes the dates as ISO strings", () => {
    expect(serializePrompt(row())).toEqual({
      id: "prompt-1",
      name: "review",
      description: "Review the staged changes",
      argumentHint: "[focus]",
      scope: "coder",
      content: "Review the staged changes.",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });
});

describe("createPrompt", () => {
  it("writes the prompt under its owner", async () => {
    mockPrompt.findFirst.mockResolvedValue(null);
    mockPrompt.create.mockResolvedValue(row());

    const result = await createPrompt("user-1", VALID);

    expect(mockPrompt.create).toHaveBeenCalledWith({ data: { userId: "user-1", ...VALID } });
    expect(result).toEqual({ ok: true, prompt: row() });
  });

  it("refuses a name the user already uses", async () => {
    mockPrompt.findFirst.mockResolvedValue(row());

    const result = await createPrompt("user-1", VALID);

    expect(result).toEqual({
      ok: false,
      error: "You already have a prompt named /review.",
      conflict: true,
    });
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("reports a name claimed by a concurrent write as the same conflict", async () => {
    mockPrompt.findFirst.mockResolvedValue(null);
    mockPrompt.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    const result = await createPrompt("user-1", VALID);

    expect(result).toMatchObject({ ok: false, conflict: true });
  });

  it("rethrows anything else", async () => {
    mockPrompt.findFirst.mockResolvedValue(null);
    mockPrompt.create.mockRejectedValue(new Error("db down"));

    await expect(createPrompt("user-1", VALID)).rejects.toThrow("db down");
  });
});

describe("updatePrompt", () => {
  it("returns null for a prompt the user does not own", async () => {
    mockPrompt.findFirst.mockResolvedValue(null);

    expect(await updatePrompt("user-1", "prompt-2", VALID)).toBeNull();
    expect(mockPrompt.update).not.toHaveBeenCalled();
  });

  it("updates the user's own row", async () => {
    mockPrompt.findFirst
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ id: "prompt-1" }));
    mockPrompt.update.mockResolvedValue(row({ name: "review" }));

    const result = await updatePrompt("user-1", "prompt-1", VALID);

    expect(mockPrompt.update).toHaveBeenCalledWith({
      where: { id: "prompt-1", userId: "user-1" },
      data: VALID,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a name another of the user's prompts holds", async () => {
    mockPrompt.findFirst
      .mockResolvedValueOnce(row({ id: "prompt-1" }))
      .mockResolvedValueOnce(row({ id: "prompt-2" }));

    const result = await updatePrompt("user-1", "prompt-1", VALID);

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(mockPrompt.update).not.toHaveBeenCalled();
  });
});

describe("deletePrompt", () => {
  it("reports whether a row was removed", async () => {
    mockPrompt.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await deletePrompt("user-1", "prompt-1")).toBe(true);
    expect(await deletePrompt("user-1", "prompt-9")).toBe(false);
    expect(mockPrompt.deleteMany).toHaveBeenCalledWith({
      where: { id: "prompt-1", userId: "user-1" },
    });
  });
});
