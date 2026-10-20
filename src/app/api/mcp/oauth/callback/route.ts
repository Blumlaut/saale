import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { prisma } from "@/lib/db";
import {
  clearMcpOAuthState,
  completeMcpOAuthSignIn,
  failMcpOAuthSignIn,
  markMcpOAuthSignInSucceeded,
  resolveMcpOAuthState,
} from "@/lib/mcp/oauth";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/**
 * GET /api/mcp/oauth/callback. where an authorization server sends the browser
 * after the user approves an MCP sign-in.
 *
 * This route is public on purpose: the browser arrives here from the provider,
 * authenticated by the one-time `state` we stored before redirecting. Requiring
 * a Saale session would break sign-ins started in another browser or profile.
 */

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");

  if (!state) {
    return html(oauthErrorHtml("The sign-in response is missing its state."), 400);
  }

  const link = await resolveMcpOAuthState(state);
  if (!link) {
    return html(
      oauthErrorHtml(
        "This sign-in has expired or was already completed.",
        "Start the sign-in again from Saale's MCP settings.",
      ),
      400,
    );
  }

  try {
    const server = await prisma.mcpServer.findFirst({
      where: { id: link.serverId, userId: link.userId },
    });
    if (!server) {
      return html(oauthErrorHtml("The MCP server this sign-in belongs to no longer exists."), 400);
    }

    const providerError = query.get("error");
    if (providerError) {
      const description = query.get("error_description") ?? providerError;
      await failMcpOAuthSignIn(link.userId, link.serverId, description);
      return html(oauthErrorHtml("The sign-in was not completed.", description), 400);
    }

    const code = query.get("code");
    if (!code) {
      await failMcpOAuthSignIn(
        link.userId,
        link.serverId,
        "The authorization response had no code.",
      );
      return html(
        oauthErrorHtml("The sign-in response did not include an authorization code."),
        400,
      );
    }

    await completeMcpOAuthSignIn(
      { id: server.id, userId: server.userId, name: server.name, url: server.url },
      { code, ...(query.get("iss") ? { iss: query.get("iss") as string } : {}) },
    );
    await markMcpOAuthSignInSucceeded(link.userId, link.serverId);

    // The server's tools become available on the next session.
    await evictUserSessions(link.userId);

    return html(
      oauthSuccessHtml(
        `MCP server "${server.name}" is connected. You can close this tab and return to Saale.`,
      ),
    );
  } catch (err) {
    console.error(`MCP OAuth callback failed for server ${link.serverId}:`, err);
    const message = err instanceof Error ? err.message : "The sign-in could not be completed.";
    await failMcpOAuthSignIn(link.userId, link.serverId, message);
    return html(oauthErrorHtml("The sign-in could not be completed.", message), 400);
  } finally {
    // The state is single-use: a replayed callback must not re-exchange a code.
    await clearMcpOAuthState(state);
  }
}
