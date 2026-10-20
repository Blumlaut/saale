import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// ─── Setup ───────────────────────────────────────────────────────────────────
// The client reads OPEN_TERMINAL_URL / OPEN_TERMINAL_API_KEY at module load,
// so stub the env, silence the startup log, and import dynamically.

let clientModule: typeof import("@/lib/terminal/client");
const mockFetch = vi.fn();
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubEnv("OPEN_TERMINAL_URL", "http://terminal.test:8000");
  vi.stubEnv("OPEN_TERMINAL_API_KEY", "test-secret-key");
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", mockFetch);
  vi.resetModules();
  clientModule = await import("@/lib/terminal/client");
});

afterAll(() => {
  consoleLogSpy.mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function okResponse(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// ─── uploadFile ──────────────────────────────────────────────────────────────

describe("uploadFile", () => {
  it("posts multipart form data to /files/upload with the directory query param", async () => {
    const content = Buffer.from("binary \x00\x01\x02 content");
    mockFetch.mockResolvedValue(
      okResponse({ path: "/home/u12345678/telegram_files/report.pdf", size: content.length }),
    );

    const result = await clientModule.uploadFile("report.pdf", content, {
      directory: "telegram_files",
      userId: "user-1",
      sessionId: "session-42",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://terminal.test:8000/files/upload?directory=telegram_files");
    expect(init.method).toBe("POST");

    // Body is a multipart form containing the exact bytes under the file name
    expect(init.body).toBeInstanceOf(FormData);
    const entry = (init.body as FormData).get("file");
    expect(entry).toBeInstanceOf(File);
    const file = entry as File;
    expect(file.name).toBe("report.pdf");
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe(content.toString("latin1"));

    expect(result).toEqual({
      path: "/home/u12345678/telegram_files/report.pdf",
      size: content.length,
    });
  });

  it("sends auth, user and session headers without a JSON content type", async () => {
    mockFetch.mockResolvedValue(okResponse({ path: "/home/u/f.txt", size: 1 }));

    await clientModule.uploadFile("f.txt", Buffer.from("x"), {
      directory: "telegram_files",
      userId: "user-1",
      sessionId: "session-42",
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-secret-key");
    expect(headers["X-User-Id"]).toBe("user-1");
    expect(headers["X-Session-Id"]).toBe("session-42");
    // Multipart: fetch derives Content-Type from the FormData  a JSON
    // content type would corrupt the request.
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
  });

  it("omits the session header when no sessionId is given", async () => {
    mockFetch.mockResolvedValue(okResponse({ path: "/home/u/f.txt", size: 1 }));

    await clientModule.uploadFile("f.txt", Buffer.from("x"), {
      directory: "telegram_files",
      userId: "user-1",
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Session-Id"]).toBeUndefined();
  });

  it("throws a descriptive error including the response body on failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "Payload Too Large",
      text: async () => "file exceeds the 50MB limit",
    });

    await expect(
      clientModule.uploadFile("big.bin", Buffer.from("x"), {
        directory: "telegram_files",
        userId: "user-1",
      }),
    ).rejects.toThrow("Open Terminal error 413: Payload Too Large. file exceeds the 50MB limit");
  });

  it("throws even when the error body cannot be read", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => {
        throw new Error("network reset");
      },
    });

    await expect(
      clientModule.uploadFile("f.txt", Buffer.from("x"), {
        directory: "telegram_files",
        userId: "user-1",
      }),
    ).rejects.toThrow("Open Terminal error 502: Bad Gateway");
  });
});
