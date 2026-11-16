import { NextResponse } from "next/server";
import { mcpOAuthClientMetadata } from "@/lib/mcp/oauth";

/**
 * GET /api/mcp/oauth/client-metadata. what identifies this instance during an
 * MCP sign-in, for servers that read Client ID Metadata Documents.
 *
 * Public on purpose: the authorization server fetches the document without
 * credentials, and its URL is the `client_id` the sign-in sends.
 */
export async function GET() {
  return NextResponse.json(await mcpOAuthClientMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
