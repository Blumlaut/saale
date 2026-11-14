import { describe, it, expect, vi, afterEach } from "vitest";
import type { ImageModel } from "@earendil-works/pi-ai";
import { generateImages } from "@/lib/providers/images/openai-images";

const MODEL: ImageModel<"openai-images"> = {
  type: "image",
  provider: "custom",
  id: "flux",
  name: "Flux",
  api: "openai-images",
  baseUrl: "http://localhost:8081/v1",
  input: ["text", "image"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** The one image response the fake server answers with. */
function stubServer(response: Record<string, unknown>, init: { status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers({ "content-type": "image/png" }),
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generateImages (openai-images)", () => {
  it("posts the prompt to the generations endpoint and returns the image blocks", async () => {
    const fetchMock = stubServer({ data: [{ b64_json: "aW1n" }] });

    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "A red fox in the snow" }] },
      { apiKey: "secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8081/v1/images/generations",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]![1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(JSON.parse(request.body)).toEqual({
      model: "flux",
      prompt: "A red fox in the snow",
      n: 1,
    });
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(result.stopReason).toBe("stop");
    expect(result.output).toEqual([{ type: "image", data: "aW1n", mimeType: "image/png" }]);
  });

  // A reference image is an img2img request, which the same API serves as a
  // multipart edit.
  it("sends a reference image to the edits endpoint", async () => {
    const fetchMock = stubServer({ data: [{ b64_json: "ZWRpdA==" }] });

    const result = await generateImages(
      MODEL,
      {
        input: [
          { type: "text", text: "Make it snow" },
          { type: "image", data: "cmVm", mimeType: "image/png" },
        ],
      },
      { apiKey: "secret" },
    );

    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: FormData }];
    expect(url).toBe("http://localhost:8081/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("prompt")).toBe("Make it snow");
    expect(init.body.getAll("image")).toHaveLength(1);
    expect(result.output).toHaveLength(1);
  });

  it("reports the server's reason instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubServer({ error: "no recipe selected" }, { status: 400 });

    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "a fox" }] },
      { apiKey: "secret" },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("400");
    expect(result.errorMessage).toContain("no recipe selected");
    expect(result.output).toEqual([]);
  });

  it("needs a credential", async () => {
    const result = await generateImages(MODEL, { input: [{ type: "text", text: "a fox" }] });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("No API key");
  });
});
