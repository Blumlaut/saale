import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

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

  /* ── Auth ── */

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  /* ── Validation ── */

  it("returns 400 when provider is missing", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?model=claude-sonnet-4",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing provider or model parameter");
  });

  it("returns 400 when model is missing", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic",
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing provider or model parameter");
  });

  it("returns 400 when both provider and model are missing", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });

    const request = new NextRequest("http://localhost/api/models/thinking-levels");
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  /* ── Model resolution ── */

  it("returns 404 when model is not found in runtime", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
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

  it("handles model IDs with dashes and version dates", async () => {
    const mockModel = {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off", "medium", "high"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4-20250514",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe("claude-sonnet-4-20250514");
  });

  it("handles URL-encoded provider/model names", async () => {
    const mockModel = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=openai&model=gpt-4o",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-4o");
  });

  /* ── Thinking level responses ── */

  it("returns full thinking level range for models that support all levels", async () => {
    const mockModel = {
      id: "claude-opus-4",
      name: "Claude Opus 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-opus-4",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reasoning).toBe(true);
    expect(body.levels).toHaveLength(7);
    expect(body.levels).toContain("off");
    expect(body.levels).toContain("max");
  });

  it("returns subset of levels for models with limited support", async () => {
    const mockModel = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
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
    expect(body.levels).toEqual(["off", "low", "medium", "high"]);
    expect(body.levels).not.toContain("xhigh");
    expect(body.levels).not.toContain("max");
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
      user: { id: "user-1" },
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

  it("handles models with reasoning flag true but limited levels", async () => {
    const mockModel = {
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      provider: "google",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    // Model supports reasoning but only has on/off
    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off", "medium"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=google&model=gemini-2.0-flash",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reasoning).toBe(true);
    expect(body.levels).toEqual(["off", "medium"]);
  });

  /* ── Error handling ── */

  it("handles buildModelRuntime throwing an error", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockRejectedValue(new Error("Database connection failed"));

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4",
    );

    await expect(GET(request)).rejects.toThrow("Database connection failed");
  });

  it("handles getSupportedThinkingLevels throwing an error", async () => {
    const mockModel = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockImplementation(() => {
      throw new Error("Invalid model configuration");
    });

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4",
    );

    await expect(GET(request)).rejects.toThrow("Invalid model configuration");
  });

  /* ── User isolation ── */

  it("calls buildModelRuntime with the authenticated user's ID", async () => {
    const mockModel = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      reasoning: true,
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-specific-123" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getModel: vi.fn().mockReturnValue(mockModel),
      } as never,
      models: [],
    });

    vi.mocked(piAi.getSupportedThinkingLevels).mockReturnValue(["off", "high"]);

    const request = new NextRequest(
      "http://localhost/api/models/thinking-levels?provider=anthropic&model=claude-sonnet-4",
    );
    await GET(request);

    expect(models.buildModelRuntime).toHaveBeenCalledWith("user-specific-123");
  });
});
