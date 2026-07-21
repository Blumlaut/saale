import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getSupportedThinkingLevels: vi.fn(),
}));

import * as auth from "@/lib/auth";
import * as models from "@/lib/pi/models";
import * as piAi from "@earendil-works/pi-ai";
import { GET } from "@/app/api/models/thinking-levels/route";

describe("GET /api/models/thinking-levels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when provider or model is missing", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    const request = new NextRequest("http://localhost/api/models/thinking-levels");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing provider or model parameter");
  });

  it("returns available thinking levels for a model", async () => {
    const mockModel = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off", "low", "medium", "high"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-sonnet-4");
    expect(body.reasoning).toBe(true);
    expect(body.levels).toEqual(["off", "low", "medium", "high"]);
  });

  it("returns 404 when model is not found", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(undefined),
      } as never,
      models: [],
    });

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=unknown&model=nonexistent",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Model not found");
  });

  it("returns only 'off' for non-reasoning models", async () => {
    const mockModel = {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      provider: "openai",
      reasoning: false,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=openai&model=gpt-4o-mini",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reasoning).toBe(false);
    expect(body.levels).toEqual(["off"]);
  });
});
