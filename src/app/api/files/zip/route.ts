import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/files/http";
import { requireWithinRoot } from "@/lib/files/paths";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import { planZip, streamZip } from "@/lib/files/zip";

/**
 * GET /api/files/zip?target=&dir=&path=…&includeDotfiles=
 *
 * The selection as one archive: `path` repeats, so any mix of files and folders
 * downloads together. Entry names are relative to `dir`. the folder being
 * browsed. which keeps the shape of the tree and makes collisions between
 * same-named files in different folders impossible.
 *
 * The selection is measured before anything is written: an oversized zip is a
 * 413 with a sentence, not a download that half-works.
 */
export async function GET(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const params = request.nextUrl.searchParams;
    const dir = resolveRequestPath(target.opened, params.get("dir"));
    const selections = params
      .getAll("path")
      .map((path) => requireWithinRoot(target.opened.info.root, path));

    if (selections.length === 0) {
      return NextResponse.json({ error: "Nothing selected" }, { status: 400 });
    }

    const plan = await planZip(target.opened.provider, dir, selections, {
      includeDotfiles: params.get("includeDotfiles") === "1",
    });

    return new NextResponse(streamZip(target.opened.provider, plan), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(plan.fileName),
        // The archive was built for this request; nothing about it is reusable.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return fileErrorResponse(err, "GET /api/files/zip");
  }
}
