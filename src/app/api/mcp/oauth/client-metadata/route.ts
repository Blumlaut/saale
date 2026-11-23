import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { mcpOAuthClientMetadata } from "@/lib/mcp/oauth";
import { getRequestPublicUrl } from "@/lib/public-url";

/**
 * GET /api/mcp/oauth/client-metadata. what identifies this instance during an
 * MCP sign-in, for servers that read Client ID Metadata Documents.
 *
 * Public on purpose: the authorization server fetches the document without
 * credentials, and its URL is the `client_id` the sign-in sends.
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(await mcpOAuthClientMetadata(getRequestPublicUrl(request)), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
