/**
 * Sending a file to a workspace, one slice at a time.
 *
 * A single request carries one chunk, so the browser never holds a second copy
 * of a large file and a lost connection costs a chunk rather than the upload.
 * Chunks go out over `XMLHttpRequest` because it reports upload bytes; `fetch`
 * only tells you when the whole body is away.
 *
 * Two shapes share the machinery: {@link uploadFile} lands the file in a folder,
 * {@link stageFile} stops short and hands the id to a caller that adopts it.
 */

import { MAX_UPLOAD_CHUNK_BYTES } from "@/lib/files/config";

/** How far along one file in a batch is. */
export interface UploadProgress {
  name: string;
  /** Bytes the server has. */
  sent: number;
  total: number;
  /** 1-based position of this file in the batch. */
  index: number;
  count: number;
}

export type UploadFailure = "exists" | "too-large" | "invalid-name" | "failed";

export type UploadResult =
  { ok: true; name: string } | { ok: false; name: string; reason: UploadFailure; message: string };

/** A file sitting in the workspace's scratch directory, waiting to be adopted. */
export interface StagedFile {
  uploadId: string;
  fileName: string;
  size: number;
  mimeType: string;
}

export type StageResult = { ok: true; staged: StagedFile } | Extract<UploadResult, { ok: false }>;

export interface UploadOptions {
  /** Workspace token: `user`, or `council:<id>`. */
  target: string;
  /** Destination folder, absolute. A staged upload ignores it. */
  dir: string;
  /** Position in a batch, so the progress the caller shows reads "2 of 3". */
  batch?: { index: number; count: number } | undefined;
  overwrite?: boolean | undefined;
  onProgress?: ((progress: UploadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** A ceiling the caller cannot solve by retrying. */
class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Refused";
    this.status = status;
  }
}

function failure(file: File, status: number, body: unknown): Extract<UploadResult, { ok: false }> {
  const reason: UploadFailure =
    status === 409
      ? "exists"
      : status === 413
        ? "too-large"
        : status === 400
          ? "invalid-name"
          : "failed";
  return { ok: false, name: file.name, reason, message: messageFrom(body) };
}

function messageFrom(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "Upload failed.";
}

function url(path: string, target: string, extra: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ target, ...extra }).toString()}`;
}

/** One request, reporting the bytes it has sent so far. */
function request(
  path: string,
  init: {
    method: string;
    body?: string | Blob;
    headers?: Record<string, string>;
    onUpload?: (loaded: number) => void;
    signal?: AbortSignal | undefined;
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(init.method, path);
    for (const [header, value] of Object.entries(init.headers ?? {})) {
      xhr.setRequestHeader(header, value);
    }
    xhr.upload.onprogress = (event) => init.onUpload?.(event.loaded);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (err) {
        console.error(`Upload response was not JSON for ${path}:`, err);
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error("The upload connection failed."));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

    init.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(init.body ?? null);
  });
}

function postJson(path: string, payload: unknown, signal?: AbortSignal) {
  return request(path, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    signal,
  });
}

/** One chunk, sent again once if the server or the network stumbled. */
async function putChunk(
  file: File,
  uploadId: string,
  index: number,
  options: UploadOptions,
): Promise<void> {
  const start = index * MAX_UPLOAD_CHUNK_BYTES;
  const slice = file.slice(start, Math.min(start + MAX_UPLOAD_CHUNK_BYTES, file.size));
  const target = url("/api/files/upload/chunk", options.target, {
    id: uploadId,
    index: String(index),
  });
  const report = (sent: number) =>
    options.onProgress?.({
      name: file.name,
      sent,
      total: file.size,
      index: options.batch?.index ?? 1,
      count: options.batch?.count ?? 1,
    });

  for (let attempt = 0; ; attempt += 1) {
    try {
      const { status, body } = await request(target, {
        method: "PUT",
        body: slice,
        headers: { "Content-Type": "application/octet-stream" },
        onUpload: (loaded) => report(start + loaded),
        signal: options.signal,
      });
      if (status < 400) {
        report(start + slice.size);
        return;
      }
      // A 4xx will say the same thing next time; a 5xx may not.
      if (status < 500 || attempt > 0) throw new Refused(status, messageFrom(body));
    } catch (err) {
      if (err instanceof Refused || attempt > 0) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

/** Init, then every chunk. Returns the id the staged bytes are named with. */
async function beginAndSend(
  file: File,
  options: UploadOptions,
  inbox: boolean,
): Promise<{ ok: true; uploadId: string } | Extract<UploadResult, { ok: false }>> {
  const init = await postJson(
    url("/api/files/upload/init", options.target, options.overwrite ? { overwrite: "1" } : {}),
    { path: options.dir, name: file.name, size: file.size, inbox },
    options.signal,
  );
  if (init.status >= 400) return failure(file, init.status, init.body);

  const uploadId = (init.body as { uploadId?: string } | null)?.uploadId;
  if (!uploadId)
    return { ok: false, name: file.name, reason: "failed", message: "Upload was not accepted." };

  try {
    for (let index = 0; index * MAX_UPLOAD_CHUNK_BYTES < file.size; index += 1) {
      await putChunk(file, uploadId, index, options);
    }
    return { ok: true, uploadId };
  } catch (err) {
    await discardStagedUpload(options.target, uploadId);
    if (err instanceof Refused) return failure(file, err.status, { error: err.message });
    throw err;
  }
}

/** Forget the bytes of an upload the client gave up on. */
export async function discardStagedUpload(target: string, uploadId: string): Promise<void> {
  try {
    await postJson(url("/api/files/upload/abort", target), { uploadId });
  } catch (err) {
    // The bytes sit in the workspace's scratch directory, which gets emptied
    // anyway. Worth a line, not worth failing the upload twice over.
    console.error(`Failed to discard staged upload ${uploadId}:`, err);
  }
}

/** Stage a file and hand back its id. */
export async function stageFile(file: File, options: UploadOptions): Promise<StageResult> {
  const started = await beginAndSend(file, options, true);
  if (!started.ok) return started;

  return {
    ok: true,
    staged: {
      uploadId: started.uploadId,
      fileName: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    },
  };
}

/** Send a file into a folder of the workspace. */
export async function uploadFile(file: File, options: UploadOptions): Promise<UploadResult> {
  const started = await beginAndSend(file, options, false);
  if (!started.ok) return started;

  const done = await postJson(
    url("/api/files/upload/complete", options.target, options.overwrite ? { overwrite: "1" } : {}),
    { path: options.dir, name: file.name, size: file.size, uploadId: started.uploadId },
    options.signal,
  );
  if (done.status >= 400) {
    await discardStagedUpload(options.target, started.uploadId);
    return failure(file, done.status, done.body);
  }

  return { ok: true, name: file.name };
}
