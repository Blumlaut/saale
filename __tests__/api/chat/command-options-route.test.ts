import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The options route is what the composer asks while a `size:` is being typed:
 * the resolutions belong to the account's image model, so they cannot come from
 * the catalog.
 */

const { mockRequireChatSessionOwner, mockImageOptions, mockModelOptions } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockImageOptions: vi.fn(),
  mockModelOptions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/commands/handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commands/handlers")>();
  return {
    COMMAND_HANDLERS: {
      ...actual.COMMAND_HANDLERS,
      image: { ...actual.COMMAND_HANDLERS.image, options: mockImageOptions },
      model: { ...actual.COMMAND_HANDLERS.model, options: mockModelOptions },
    },
  };
});

import { GET } from "@/app/api/chat/sessions/[sessionId]/command/options/route";

const USER_ID = "options-user";
const SESSION_ID = "options-session";

function get(name: string) {
  return GET(
    new NextRequest(
      `http://localhost/api/chat/sessions/x/command/options?name=${encodeURIComponent(name)}`,
    ),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID });
  mockImageOptions.mockResolvedValue({
    size: [{ value: "1024x1536", label: "1024 × 1536 · portrait" }],
  });
  mockModelOptions.mockResolvedValue({
    name: [{ value: "ollama:qwen3.5-9b", label: "qwen3.5-9b" }],
  });
});

describe("GET /api/chat/sessions/[sessionId]/command/options", () => {
  it("refuses a session the caller does not own", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    });

    expect((await get("image")).status).toBe(404);
    expect(mockImageOptions).not.toHaveBeenCalled();
  });

  it("lists what the command's arguments accept, for the authenticated user", async () => {
    const res = await get("image");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      options: { size: [{ value: "1024x1536", label: "1024 × 1536 · portrait" }] },
    });
    expect(mockImageOptions).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "web", userId: USER_ID, sessionId: SESSION_ID }),
    );
  });

  it("lists a command's dynamic choice whichever one it is", async () => {
    const res = await get("model");

    expect(await res.json()).toEqual({
      options: { name: [{ value: "ollama:qwen3.5-9b", label: "qwen3.5-9b" }] },
    });
  });

  it("has nothing to list for a command whose arguments it knows", async () => {
    const res = await get("stfu");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ options: {} });
  });

  it("refuses a name the catalog does not know", async () => {
    const res = await get("nope");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown command: /nope");
  });

  it("reports a failure as a 500 with the reason", async () => {
    mockImageOptions.mockRejectedValue(new Error("The provider list is down"));

    const res = await get("image");

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The provider list is down");
  });
});
