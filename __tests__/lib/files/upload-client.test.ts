// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Four bytes a chunk keeps the slicing visible on tiny fixtures.
vi.mock("@/lib/files/config", () => ({ MAX_UPLOAD_CHUNK_BYTES: 4 }));

import { stageFile, uploadFile, type UploadProgress } from "@/lib/files/upload-client";

interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  xhr: FakeXhr;
}

const requests: FakeRequest[] = [];

/** Answer each request as it is sent, and record it. */
let answer: (request: FakeRequest) => void;

class FakeXhr {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    const request: FakeRequest = {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body,
      xhr: this,
    };
    requests.push(request);
    answer(request);
  }

  abort() {
    this.onabort?.();
  }

  /** Finish the request the way the browser would. */
  respond(status: number, body?: unknown) {
    this.status = status;
    this.responseText = body === undefined ? "" : JSON.stringify(body);
    this.onload?.();
  }
}

function file(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

function path(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

function search(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

/** Answer the init call, then every chunk with 200, then complete. */
function succeed(options: { initStatus?: number; initBody?: unknown } = {}) {
  answer = (request) => {
    if (path(request.url) === "/api/files/upload/init") {
      request.xhr.respond(options.initStatus ?? 200, options.initBody ?? { uploadId: "u-1" });
      return;
    }
    if (path(request.url) === "/api/files/upload/chunk") {
      request.xhr.upload.onprogress?.({ loaded: (request.body as Blob).size });
      request.xhr.respond(200, { received: 1 });
      return;
    }
    request.xhr.respond(200, { uploaded: "x" });
  };
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  succeed();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("slices the file into chunk requests and then moves it into place", async () => {
    const result = await uploadFile(file("notes.txt", "abcdefghij"), { target: "user", dir: "/w" });

    expect(result).toEqual({ ok: true, name: "notes.txt" });
    expect(requests.map((request) => `${request.method} ${path(request.url)}`)).toEqual([
      "POST /api/files/upload/init",
      "PUT /api/files/upload/chunk",
      "PUT /api/files/upload/chunk",
      "PUT /api/files/upload/chunk",
      "POST /api/files/upload/complete",
    ]);

    // Chunks are named by index and carry the slice they cover.
    expect(requests.slice(1, 4).map((request) => search(request.url).get("index"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(requests.slice(1, 4).map((request) => (request.body as Blob).size)).toEqual([4, 4, 2]);

    expect(JSON.parse(requests[0]!.body as string)).toEqual({
      path: "/w",
      name: "notes.txt",
      size: 10,
      inbox: false,
    });
    expect(JSON.parse(requests[4]!.body as string)).toEqual({
      path: "/w",
      name: "notes.txt",
      size: 10,
      uploadId: "u-1",
    });
  });

  it("reports bytes as they land, ending on the file's full size", async () => {
    const seen: UploadProgress[] = [];

    await uploadFile(file("notes.txt", "abcdefghij"), {
      target: "user",
      dir: "/w",
      batch: { index: 2, count: 3 },
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen.at(-1)).toEqual({
      name: "notes.txt",
      sent: 10,
      total: 10,
      index: 2,
      count: 3,
    });
    // Never reports more than it has.
    expect(Math.max(...seen.map((progress) => progress.sent))).toBe(10);
  });

  it("stops before shipping bytes when the name is taken", async () => {
    succeed({ initStatus: 409, initBody: { error: "1 file(s) already exist" } });

    const result = await uploadFile(file("notes.txt", "x"), { target: "user", dir: "/w" });

    expect(result).toMatchObject({ ok: false, reason: "exists" });
    expect(requests).toHaveLength(1);
  });

  it("sends a chunk again once when the server stumbles", async () => {
    let failed = false;
    answer = (request) => {
      if (path(request.url) === "/api/files/upload/init") {
        request.xhr.respond(200, { uploadId: "u-1" });
        return;
      }
      if (path(request.url) === "/api/files/upload/chunk" && !failed) {
        failed = true;
        request.xhr.respond(503, { error: "nope" });
        return;
      }
      if (path(request.url) === "/api/files/upload/chunk") {
        request.xhr.respond(200, { received: 1 });
        return;
      }
      request.xhr.respond(200, { uploaded: "x" });
    };

    const result = await uploadFile(file("notes.txt", "abc"), { target: "user", dir: "/w" });

    expect(result).toEqual({ ok: true, name: "notes.txt" });
    expect(requests.filter((request) => path(request.url).endsWith("/chunk"))).toHaveLength(2);
  });

  it("drops the staged bytes when a chunk is refused outright", async () => {
    answer = (request) => {
      if (path(request.url) === "/api/files/upload/init") {
        request.xhr.respond(200, { uploadId: "u-1" });
        return;
      }
      if (path(request.url) === "/api/files/upload/chunk") {
        request.xhr.respond(413, { error: "A chunk may be at most 4 B" });
        return;
      }
      request.xhr.respond(200, { ok: true });
    };

    const result = await uploadFile(file("notes.txt", "abcdefgh"), { target: "user", dir: "/w" });

    expect(result).toMatchObject({ ok: false, reason: "too-large" });
    expect(path(requests.at(-1)!.url)).toBe("/api/files/upload/abort");
    expect(JSON.parse(requests.at(-1)!.body as string)).toEqual({ uploadId: "u-1" });
  });

  it("gives up when the caller aborts", async () => {
    const controller = new AbortController();
    answer = (request) => {
      if (path(request.url) === "/api/files/upload/init") {
        request.xhr.respond(200, { uploadId: "u-1" });
        return;
      }
      controller.abort();
      request.xhr.abort();
    };

    await expect(
      uploadFile(file("notes.txt", "abcdefgh"), {
        target: "user",
        dir: "/w",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Aborted/);
  });
});

describe("stageFile", () => {
  it("asks for an inbox upload and hands the id back", async () => {
    const result = await stageFile(file("snapshot.tar", "abcd", "application/x-tar"), {
      target: "user",
      dir: "",
    });

    expect(result).toEqual({
      ok: true,
      staged: {
        uploadId: "u-1",
        fileName: "snapshot.tar",
        size: 4,
        mimeType: "application/x-tar",
      },
    });
    expect(JSON.parse(requests[0]!.body as string)).toMatchObject({ inbox: true });
    // Staging never completes the upload: the caller adopts it.
    expect(requests.map((request) => path(request.url))).toEqual([
      "/api/files/upload/init",
      "/api/files/upload/chunk",
    ]);
  });

  it("types an untyped file as a byte stream", async () => {
    const result = await stageFile(file("blob.bin", "ab", ""), { target: "user", dir: "" });

    expect(result.ok && result.staged.mimeType).toBe("application/octet-stream");
  });
});
