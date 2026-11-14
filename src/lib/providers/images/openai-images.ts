/**
 * Image generation over the OpenAI images API (`/v1/images/generations`).
 *
 * Pi implements one images API, OpenRouter's, which speaks chat completions.
 * Everything that serves the OpenAI images API needs this adapter: a diffusion
 * server such as stable-diffusion.cpp's, and OpenAI's own image models. It is
 * registered per provider with `registerProvider(..., { images: {
 * "openai-images": { generateImages } } })`.
 *
 * A reference image goes to `/v1/images/edits`, which the same servers implement
 * for img2img work. Which of the two endpoints a call lands on is decided by the
 * context, not by the model: an input image is an edit.
 */

import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  ImagesOutputContent,
  Usage,
} from "@earendil-works/pi-ai";

/** The images api this adapter implements. */
export const OPENAI_IMAGES_API = "openai-images";

/**
 * How long one image call may take.
 *
 * A local diffusion server renders in tens of seconds, a hosted one in a minute
 * or two, and a queued request waits for the cards it is behind.
 */
const IMAGE_TIMEOUT_MS = 300_000;

/** Response bodies kept for an error message: enough for the server's reason. */
const MAX_ERROR_BODY = 500;

/** An image response entry, as OpenAI-compatible servers send it. */
interface ImageResponseEntry {
  b64_json?: string;
  url?: string;
}

/** Context split into what the endpoint takes as a prompt and as references. */
interface SplitInput {
  prompt: string;
  images: ImageContent[];
}

function splitInput(context: ImagesContext): SplitInput {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const block of context.input) {
    if (block.type === "text") text.push(block.text);
    else images.push(block);
  }
  return { prompt: text.join("\n").trim(), images };
}

function errorResult(
  model: ImageModel<ImageApi>,
  message: string,
  options?: ImagesOptions,
): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: options?.signal?.aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/** The bytes of one response entry, base64 and its MIME type. */
async function readEntry(entry: ImageResponseEntry): Promise<ImagesOutputContent | null> {
  if (typeof entry.b64_json === "string" && entry.b64_json.length > 0) {
    return { type: "image", data: entry.b64_json, mimeType: "image/png" };
  }
  if (typeof entry.url !== "string" || entry.url.length === 0) return null;

  const dataUrl = /^data:([^;]+);base64,(.+)$/.exec(entry.url);
  if (dataUrl) return { type: "image", data: dataUrl[2]!, mimeType: dataUrl[1]! };

  // Some servers answer with a link instead of the bytes; the caller has no
  // second chance to fetch it once the result is returned.
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`Failed to download the generated image (${response.status})`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { type: "image", data, mimeType };
}

/**
 * Token usage and its price, when a server reports it.
 *
 * OpenAI's own image models bill per image and report token counts; a local
 * server reports neither, and a result without usage leaves the cost at zero.
 */
function readUsage(raw: unknown, model: ImageModel<ImageApi>): Usage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  if (input === 0 && output === 0) return undefined;

  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: (input / 1_000_000) * model.cost.input,
      output: (output / 1_000_000) * model.cost.output,
      cacheRead: 0,
      cacheWrite: 0,
      total: (input / 1_000_000) * model.cost.input + (output / 1_000_000) * model.cost.output,
    },
  };
}

/** The request body of a generation, after the caller's own rewrite. */
async function generationPayload(
  model: ImageModel<ImageApi>,
  prompt: string,
  options: ImagesOptions | undefined,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { model: model.id, prompt, n: 1 };
  const rewritten = await options?.onPayload?.(body, model);
  return typeof rewritten === "object" && rewritten !== null
    ? (rewritten as Record<string, unknown>)
    : body;
}

function editPayload(model: ImageModel<ImageApi>, input: SplitInput): FormData {
  const form = new FormData();
  form.set("model", model.id);
  form.set("prompt", input.prompt);
  form.set("n", "1");
  input.images.forEach((image, index) => {
    const bytes = Buffer.from(image.data, "base64");
    form.append(
      "image",
      new Blob([new Uint8Array(bytes)], { type: image.mimeType }),
      `reference-${index}.${image.mimeType.split("/")[1] ?? "png"}`,
    );
  });
  return form;
}

/**
 * Generate an image, or edit the reference images in `context`.
 *
 * Never rejects: a failure is an `AssistantImages` with `stopReason: "error"`
 * and the server's own reason, the same shape Pi's own adapters return.
 */
export async function generateImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const apiKey = options?.apiKey;
  if (!apiKey) return errorResult(model, `No API key for provider: ${model.provider}`, options);

  const input = splitInput(context);
  if (!input.prompt && input.images.length === 0) {
    return errorResult(model, "An image needs a prompt to render", options);
  }

  const baseUrl = model.baseUrl.replace(/\/+$/, "");
  const editing = input.images.length > 0;
  const url = `${baseUrl}/images/${editing ? "edits" : "generations"}`;
  const doFetch = options?.fetch ?? fetch;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...options?.headers,
  };
  let body: BodyInit;
  if (editing) {
    body = editPayload(model, input);
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(await generationPayload(model, input.prompt, options));
  }

  try {
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body,
      signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? IMAGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, MAX_ERROR_BODY).trim();
      return errorResult(
        model,
        `The endpoint answered ${response.status}${detail ? `: ${detail}` : ""}`,
        options,
      );
    }

    const payload = (await response.json()) as { data?: ImageResponseEntry[]; usage?: unknown };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const output: ImagesOutputContent[] = [];
    for (const entry of entries) {
      const block = await readEntry(entry);
      if (block) output.push(block);
    }
    if (output.length === 0) return errorResult(model, "The endpoint returned no image", options);

    const usage = readUsage(payload.usage, model);
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output,
      ...(usage ? { usage } : {}),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(`Failed to generate an image with ${model.provider}/${model.id}:`, err);
    return errorResult(model, err instanceof Error ? err.message : String(err), options);
  }
}
