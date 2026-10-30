import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  createFakeProvider,
  FIXED_MTIME,
  readZipEntries,
  type FakeTree,
} from "../../helpers/fake-file-provider";

// Shrink the ceilings so the limit paths are reachable with tiny payloads.
vi.mock("@/lib/files/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/config")>()),
  MAX_LISTING_ENTRIES: 3,
  MAX_PREVIEW_BYTES: 32,
  MAX_DOWNLOAD_BYTES: 64,
  MAX_UPLOAD_BYTES_PER_FILE: 32,
  MAX_UPLOAD_CHUNK_BYTES: 8,
  MAX_UPLOAD_FILES: 2,
}));

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(async () => ({ ok: true, user: { id: "user-1" } })),
}));

vi.mock("@/lib/council/access", () => ({
  requireCouncilAccess: vi.fn(async () => null),
}));

vi.mock("@/lib/council/files", () => ({
  openCouncilFileTarget: vi.fn(),
}));

vi.mock("@/lib/files/targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/targets")>()),
  openUserFileTarget: vi.fn(),
}));

import { requireSession } from "@/lib/auth";
import { requireCouncilAccess } from "@/lib/council/access";
import { openCouncilFileTarget } from "@/lib/council/files";
import { WorkspaceUnavailableError } from "@/lib/files/errors";
import { openUserFileTarget } from "@/lib/files/targets";
import { FULL_CAPABILITIES } from "@/lib/files/types";
import { GET as listRoute } from "@/app/api/files/list/route";
import { GET as rawRoute } from "@/app/api/files/raw/route";
import { GET as zipRoute } from "@/app/api/files/zip/route";
import { POST as uploadInitRoute } from "@/app/api/files/upload/init/route";
import { PUT as uploadChunkRoute } from "@/app/api/files/upload/chunk/route";
import { POST as uploadCompleteRoute } from "@/app/api/files/upload/complete/route";
import { POST as uploadAbortRoute } from "@/app/api/files/upload/abort/route";
import { POST as mkdirRoute } from "@/app/api/files/mkdir/route";
import { POST as renameRoute } from "@/app/api/files/rename/route";
import { POST as deleteRoute } from "@/app/api/files/delete/route";
import { POST as writeRoute } from "@/app/api/files/write/route";
import { POST as createRoute } from "@/app/api/files/create/route";

const ROOT = "/workspace";

const TREE: FakeTree = {
  [`${ROOT}/notes.md`]: "# notes",
  [`${ROOT}/src`]: null,
  [`${ROOT}/src/app.ts`]: "export const app = 1;",
  [`${ROOT}/.env`]: "SECRET=1",
  [`${ROOT}/page.html`]: "<script>alert(1)</script>",
  [`${ROOT}/big.bin`]: "x".repeat(50),
};

function useTree(tree: FakeTree = TREE) {
  const provider = createFakeProvider(tree, ROOT);
  vi.mocked(openUserFileTarget).mockResolvedValue({
    provider,
    info: {
      id: "user",
      label: "files",
      root: ROOT,
      capabilities: FULL_CAPABILITIES,
    },
  });
  return provider;
}

function get(route: (request: NextRequest) => Promise<NextResponse>, query: string) {
  return route(new NextRequest(`http://localhost/api/files${query}`));
}

/** A workspace path as the browser sends it: absolute, then URL-encoded. */
function at(relative: string) {
  return encodeURIComponent(relative ? `${ROOT}/${relative}` : ROOT);
}

function post(
  route: (request: NextRequest) => Promise<NextResponse>,
  query: string,
  body: unknown,
) {
  return route(
    new NextRequest(`http://localhost/api/files${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function initUpload(body: Record<string, unknown>, query = "") {
  return uploadInitRoute(
    new NextRequest(`http://localhost/api/files/upload/init${query}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function putChunk(uploadId: string, index: number, chunk: string) {
  return uploadChunkRoute(
    new NextRequest(`http://localhost/api/files/upload/chunk?id=${uploadId}&index=${index}`, {
      method: "PUT",
      body: chunk,
    }),
  );
}

function completeUpload(body: Record<string, unknown>, query = "") {
  return uploadCompleteRoute(
    new NextRequest(`http://localhost/api/files/upload/complete${query}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

/**
 * One file through the three calls the browser makes, split at the shrunken
 * chunk ceiling.
 */
async function upload(query: string, name: string, content: string) {
  const init = await initUpload({ path: "/", name, size: content.length }, query);
  if (init.status >= 400) return init;

  const { uploadId } = (await init.json()) as { uploadId: string };
  for (let index = 0, offset = 0; offset < content.length; index += 1) {
    const chunk = content.slice(offset, offset + 8);
    offset += chunk.length;
    const put = await putChunk(uploadId, index, chunk);
    if (put.status >= 400) return put;
  }

  return completeUpload({ path: "/", name, size: content.length, uploadId }, query);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSession).mockResolvedValue({ ok: true, user: { id: "user-1" } });
  vi.mocked(requireCouncilAccess).mockResolvedValue(null);
});

describe("authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await get(listRoute, "?path=/");
    expect(response.status).toBe(401);
  });

  it("refuses an unknown target token", async () => {
    const response = await get(listRoute, "?target=elsewhere:/tmp&path=/");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Unknown file target" });
  });

  it("gates a council before doing any work for it", async () => {
    vi.mocked(requireCouncilAccess).mockResolvedValueOnce(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );

    const response = await get(listRoute, "?target=council:c1&path=/");

    expect(response.status).toBe(404);
    expect(openCouncilFileTarget).not.toHaveBeenCalled();
  });

  it("browses a council's workspace through the council target", async () => {
    const provider = createFakeProvider(TREE, ROOT);
    vi.mocked(openCouncilFileTarget).mockResolvedValueOnce({
      provider,
      info: {
        id: "council:c1",
        label: "Launch review",
        root: ROOT,
        capabilities: FULL_CAPABILITIES,
      },
    });

    const response = await get(listRoute, "?target=council:c1&path=/");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.target).toMatchObject({ id: "council:c1", label: "Launch review" });
  });

  it("reports a workspace that cannot be reached as a conflict, not a crash", async () => {
    vi.mocked(openCouncilFileTarget).mockRejectedValueOnce(
      new WorkspaceUnavailableError("Council workspaces need the Open Terminal integration."),
    );

    const response = await get(listRoute, "?target=council:c1&path=/");
    expect(response.status).toBe(409);
  });

  it("defaults to the caller's own workspace", async () => {
    useTree();

    const response = await get(listRoute, "?path=/");

    expect(response.status).toBe(200);
    expect(openUserFileTarget).toHaveBeenCalledWith("user-1");
  });
});

describe("GET /api/files/list", () => {
  it("lists a directory with directories first and dotfiles hidden", async () => {
    useTree({
      [`${ROOT}/src`]: null,
      [`${ROOT}/notes.md`]: "# notes",
      [`${ROOT}/zeta.txt`]: "z",
      [`${ROOT}/.env`]: "SECRET=1",
    });

    const body = await (await get(listRoute, "?path=/")).json();

    expect(body.path).toBe(ROOT);
    expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "src",
      "notes.md",
      "zeta.txt",
    ]);
    expect(body.truncated).toBe(false);
  });

  it("shows dotfiles when asked and marks a listing that hit the cap", async () => {
    useTree();

    const body = await (await get(listRoute, "?path=/&hideDotfiles=0")).json();

    expect(body.entries.map((entry: { name: string }) => entry.name)).toContain(".env");
    // Five visible rows, a cap of three: the caller is told it was cut.
    expect(body.entries).toHaveLength(3);
    expect(body.truncated).toBe(true);
  });

  it("answers 404 for a folder that is no longer there", async () => {
    const provider = useTree();
    provider.list = async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };

    const response = await get(listRoute, `?path=${at("gone")}`);

    expect(response.status).toBe(404);
  });

  it("refuses a path that climbs out of the workspace", async () => {
    useTree();

    const response = await get(listRoute, "?path=../../etc/passwd");

    expect(response.status).toBe(400);
  });
});

describe("GET /api/files/raw", () => {
  it("serves a file with a content ETag that revalidates to 304", async () => {
    useTree();

    const response = await get(rawRoute, `?path=${at("notes.md")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();

    const revalidated = await rawRoute(
      new NextRequest(`http://localhost/api/files/raw?path=${at("notes.md")}`, {
        headers: { "If-None-Match": etag as string },
      }),
    );
    expect(revalidated.status).toBe(304);
  });

  it("reports the mtime its bytes were served at, so a save is checked against the read", async () => {
    useTree();

    const response = await get(rawRoute, `?path=${at("notes.md")}`);

    expect(response.status).toBe(200);
    const modified = Number(response.headers.get("x-file-modified"));
    expect(modified).toBe(FIXED_MTIME);

    const saved = await post(writeRoute, "", {
      path: `${ROOT}/notes.md`,
      content: "# done",
      baseModified: modified,
    });
    expect(saved.status).toBe(200);
  });

  it("never serves HTML as HTML inline, but does as a download", async () => {
    useTree();

    const inline = await get(rawRoute, `?path=${at("page.html")}`);
    expect(inline.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const download = await get(rawRoute, `?path=${at("page.html")}&download=1`);
    expect(download.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(download.headers.get("content-disposition")).toContain(
      'attachment; filename="page.html"',
    );
  });

  it("refuses a preview of a file too large to show, but still allows the download", async () => {
    useTree();

    const inline = await get(rawRoute, `?path=${at("big.bin")}`);
    expect(inline.status).toBe(413);

    const download = await get(rawRoute, `?path=${at("big.bin")}&download=1`);
    expect(download.status).toBe(200);
  });

  it("answers 404 for a directory", async () => {
    useTree();

    const response = await get(rawRoute, `?path=${at("src")}`);
    expect(response.status).toBe(404);
  });
});

describe("GET /api/files/zip", () => {
  it("zips a mixed selection into one archive", async () => {
    useTree();

    const response = await get(
      zipRoute,
      `?dir=/&path=${encodeURIComponent(`${ROOT}/src`)}&path=${encodeURIComponent(`${ROOT}/notes.md`)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");

    const archive = readZipEntries(Buffer.from(await response.arrayBuffer()));
    expect(archive.map((entry) => entry.name).sort()).toEqual(["notes.md", "src/app.ts"]);
    expect(archive.find((entry) => entry.name === "src/app.ts")?.content.toString()).toBe(
      "export const app = 1;",
    );
  });

  it("names the archive after a single selected folder", async () => {
    useTree();

    const response = await get(zipRoute, `?dir=/&path=${encodeURIComponent(`${ROOT}/src`)}`);

    expect(response.headers.get("content-disposition")).toContain('filename="src.zip"');
  });

  it("refuses an empty selection and a selection outside the browsed folder", async () => {
    useTree();

    expect((await get(zipRoute, "?dir=/")).status).toBe(400);
    expect((await get(zipRoute, `?dir=/&path=${encodeURIComponent(ROOT)}`)).status).toBe(400);
    expect(
      (
        await get(
          zipRoute,
          `?dir=${encodeURIComponent(`${ROOT}/src`)}&path=${encodeURIComponent(`${ROOT}/notes.md`)}`,
        )
      ).status,
    ).toBe(400);
  });
});

describe("chunked upload", () => {
  it("assembles chunks and writes the file", async () => {
    const provider = useTree();

    const response = await upload("", "greeting.txt", "hello there");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ uploaded: "greeting.txt" });
    await expect(provider.read(`${ROOT}/greeting.txt`)).resolves.toMatchObject({
      buffer: new Uint8Array(Buffer.from("hello there")),
    });
  });

  it("refuses to replace an existing file unless overwrite is asked for", async () => {
    const provider = useTree();

    const blocked = await upload("", "notes.md", "new");
    expect(blocked.status).toBe(409);

    const replaced = await upload("?overwrite=1", "notes.md", "new");
    expect(replaced.status).toBe(200);
    await expect(provider.read(`${ROOT}/notes.md`)).resolves.toMatchObject({
      buffer: new Uint8Array(Buffer.from("new")),
    });
  });

  it("refuses a name that is a path and a file over the size ceiling", async () => {
    useTree();

    expect((await initUpload({ path: "/", name: "../evil.txt", size: 1 })).status).toBe(400);
    expect((await initUpload({ path: "/", name: "huge.bin", size: 64 })).status).toBe(413);
  });

  it("refuses a chunk that does not continue the upload", async () => {
    const provider = useTree();
    const init = await initUpload({ path: "/", name: "notes.txt", size: 16 });
    const { uploadId } = (await init.json()) as { uploadId: string };

    expect((await putChunk(uploadId, 0, "12345678")).status).toBe(200);
    // Same index again: the staged file has moved on.
    expect((await putChunk(uploadId, 0, "12345678")).status).toBe(409);
    // Skipping ahead leaves a hole.
    expect((await putChunk(uploadId, 2, "12345678")).status).toBe(409);

    await expect(provider.stat(`${ROOT}/notes.txt`)).resolves.toBeNull();
  });

  it("refuses to finish a file that arrived short", async () => {
    useTree();
    const init = await initUpload({ path: "/", name: "short.txt", size: 16 });
    const { uploadId } = (await init.json()) as { uploadId: string };
    await putChunk(uploadId, 0, "12345678");

    const done = await completeUpload({ path: "/", name: "short.txt", size: 16, uploadId });

    expect(done.status).toBe(409);
    expect((await done.json()).error).toMatch(/Upload incomplete/);
  });

  it("drops the staged bytes on abort", async () => {
    const provider = useTree();
    const init = await initUpload({ path: "/", name: "gone.txt", size: 16 });
    const { uploadId } = (await init.json()) as { uploadId: string };
    await putChunk(uploadId, 0, "12345678");

    const aborted = await uploadAbortRoute(
      new NextRequest("http://localhost/api/files/upload/abort", {
        method: "POST",
        body: JSON.stringify({ uploadId }),
      }),
    );

    expect(aborted.status).toBe(200);
    expect((await provider.list(`${ROOT}/.tmp`)).entries).toHaveLength(0);
    expect((await putChunk(uploadId, 1, "12345678")).status).toBe(409);
  });

  it("refuses a chunk larger than the ceiling", async () => {
    useTree();
    const init = await initUpload({ path: "/", name: "big.bin", size: 16 });
    const { uploadId } = (await init.json()) as { uploadId: string };

    expect((await putChunk(uploadId, 0, "x".repeat(9))).status).toBe(413);
  });

  it("refuses an upload id that was never issued", async () => {
    useTree();

    expect((await putChunk("../../etc", 0, "x")).status).toBe(404);
  });
});

describe("write endpoints", () => {
  it("creates a folder", async () => {
    const provider = useTree();

    const response = await post(mkdirRoute, "", { path: ROOT, name: "reports" });

    expect(response.status).toBe(200);
    await expect(provider.stat(`${ROOT}/reports`)).resolves.toMatchObject({ kind: "directory" });
  });

  it("refuses a folder name that is taken or is a path", async () => {
    useTree();

    expect((await post(mkdirRoute, "", { path: ROOT, name: "src" })).status).toBe(409);
    expect((await post(mkdirRoute, "", { path: ROOT, name: "a/b" })).status).toBe(400);
  });

  it("creates an empty file", async () => {
    const provider = useTree();

    const response = await post(createRoute, "", { path: ROOT, name: "todo.md" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ path: `${ROOT}/todo.md` });
    expect(Buffer.from((await provider.read(`${ROOT}/todo.md`)).buffer).toString()).toBe("");
  });

  it("refuses to create over a name that is taken, or a name that is a path", async () => {
    useTree();

    expect((await post(createRoute, "", { path: ROOT, name: "notes.md" })).status).toBe(409);
    expect((await post(createRoute, "", { path: ROOT, name: "a/b" })).status).toBe(400);
    expect((await post(createRoute, "", { path: ROOT, name: ".." })).status).toBe(400);
  });

  it("renames an entry in place", async () => {
    const provider = useTree();

    const response = await post(renameRoute, "", { path: `${ROOT}/notes.md`, name: "plan.md" });

    expect(response.status).toBe(200);
    await expect(provider.stat(`${ROOT}/plan.md`)).resolves.toMatchObject({ kind: "file" });
    await expect(provider.stat(`${ROOT}/notes.md`)).resolves.toBeNull();
  });

  it("refuses to rename onto an existing entry, or the workspace root", async () => {
    useTree();

    expect((await post(renameRoute, "", { path: `${ROOT}/notes.md`, name: "src" })).status).toBe(
      409,
    );
    expect((await post(renameRoute, "", { path: ROOT, name: "moved" })).status).toBe(400);
  });

  it("deletes a file", async () => {
    const provider = useTree();

    const response = await post(deleteRoute, "", { path: `${ROOT}/notes.md` });

    expect(response.status).toBe(200);
    await expect(provider.stat(`${ROOT}/notes.md`)).resolves.toBeNull();
  });

  it("refuses to delete the workspace root", async () => {
    const provider = useTree();

    const response = await post(deleteRoute, "", { path: ROOT });

    expect(response.status).toBe(400);
    await expect(provider.stat(ROOT)).resolves.toMatchObject({ kind: "directory" });
  });

  it("rejects a body that is not JSON", async () => {
    useTree();

    const response = await deleteRoute(
      new NextRequest("http://localhost/api/files/delete", { method: "POST", body: "nope" }),
    );

    expect(response.status).toBe(400);
  });
});

describe("POST /api/files/write", () => {
  const MTIME = FIXED_MTIME;

  it("replaces a file's text in place", async () => {
    const provider = useTree();

    const response = await post(writeRoute, "", { path: `${ROOT}/notes.md`, content: "# done" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ path: `${ROOT}/notes.md`, size: 6 });
    expect(Buffer.from((await provider.read(`${ROOT}/notes.md`)).buffer).toString()).toBe("# done");
  });

  it("refuses a path that climbs out of the workspace", async () => {
    useTree();

    const response = await post(writeRoute, "", { path: "/etc/passwd", content: "x" });

    expect(response.status).toBe(400);
  });

  it("saves only over an existing file", async () => {
    useTree();

    expect((await post(writeRoute, "", { path: `${ROOT}/gone.md`, content: "x" })).status).toBe(
      404,
    );
    expect((await post(writeRoute, "", { path: `${ROOT}/src`, content: "x" })).status).toBe(404);
  });

  it("refuses text over the size ceiling", async () => {
    useTree();

    const response = await post(writeRoute, "", {
      path: `${ROOT}/notes.md`,
      content: "x".repeat(64),
    });

    expect(response.status).toBe(413);
  });

  it("answers a stale mtime with a conflict the caller can force", async () => {
    const provider = useTree();

    const stale = await post(writeRoute, "", {
      path: `${ROOT}/notes.md`,
      content: "# mine",
      baseModified: MTIME - 1,
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "modified" });
    expect(Buffer.from((await provider.read(`${ROOT}/notes.md`)).buffer).toString()).toBe(
      "# notes",
    );

    const forced = await post(writeRoute, "", {
      path: `${ROOT}/notes.md`,
      content: "# mine",
      baseModified: MTIME - 1,
      force: true,
    });
    expect(forced.status).toBe(200);
  });

  it("accepts a save whose mtime still matches", async () => {
    useTree();

    const response = await post(writeRoute, "", {
      path: `${ROOT}/notes.md`,
      content: "# mine",
      baseModified: MTIME,
    });

    expect(response.status).toBe(200);
  });
});
