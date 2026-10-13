import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { HIDE_DOTFILES_DEFAULT, MAX_LISTING_ENTRIES } from "@/lib/files/config";
import { FileNotFoundError, isNotFoundError } from "@/lib/files/errors";
import { toListing } from "@/lib/files/provider";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import type { FileListing } from "@/lib/files/types";

/**
 * GET /api/files/list?target=&path=&hideDotfiles=
 *
 * One directory, with the workspace's capabilities alongside it so the browser
 * can render its header and hide the actions it may not take from a single
 * response.
 */
export async function GET(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const params = request.nextUrl.searchParams;
    const dir = resolveRequestPath(target.opened, params.get("path"));
    const hideDotfiles =
      (params.get("hideDotfiles") ?? (HIDE_DOTFILES_DEFAULT ? "1" : "0")) === "1";

    const listing = await target.opened.provider.list(dir).catch((err: unknown) => {
      // A folder that vanished (renamed by an agent mid-browse) is a 404 the UI
      // can recover from by navigating up, not a 500.
      if (isNotFoundError(err)) throw new FileNotFoundError(dir);
      throw err;
    });

    const { entries, truncated } = toListing(listing, dir, {
      hideDotfiles,
      limit: MAX_LISTING_ENTRIES,
    });

    const body: FileListing = { target: target.opened.info, path: dir, entries, truncated };
    return NextResponse.json(body);
  } catch (err) {
    return fileErrorResponse(err, "GET /api/files/list");
  }
}
