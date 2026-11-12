import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canExec } from "@/lib/sandbox/client";
import { cacheMcpOAuthChallenge, createMcpAuthProvider } from "@/lib/mcp/oauth";
import { describeProbeError, isMcpOAuthRequired, probeMcpServer } from "@/lib/mcp/probe";
import { readMcpEnv, readMcpToken } from "@/lib/mcp/servers";
import { probeStdioMcpServer } from "@/lib/mcp/stdio";
import {
  isMcpTransport,
  parseMcpEnv,
  validateMcpCommand,
  validateMcpCwd,
  validateMcpUrl,
} from "@/lib/mcp/shared";

/**
 * A command's first run is its install (`npx -y` fetches the package), so a
 * probe of a stdio server waits longer than an HTTP handshake does.
 */
const STDIO_PROBE_TIMEOUT_MS = 120_000;

/**
 * POST /api/mcp/servers/:serverId/test. connect to a server and list its tools.
 *
 * `serverId` may be `new`, which tests the values in the request body before
 * anything is stored. For a stored server the saved values are used unless the
 * body overrides them, so an edit can be verified before saving.
 *
 * An HTTP server with no bearer token is tested through its OAuth credentials;
 * without any, the 401 tells the settings page to offer a sign-in. A command is
 * run in the account's workspace container, the same way a chat runs it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { serverId } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const stored =
    serverId === "new"
      ? null
      : await prisma.mcpServer.findFirst({ where: { id: serverId, userId } });
  if (serverId !== "new" && !stored) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const transport = isMcpTransport(body.transport)
    ? body.transport
    : isMcpTransport(stored?.transport)
      ? stored.transport
      : "http";

  if (transport === "stdio") {
    return probeCommand({
      userId,
      name: stored?.name ?? null,
      command: stored?.command ?? null,
      cwd: stored?.cwd ?? null,
      storedEnv: stored ? readMcpEnv(stored) : {},
      body,
    });
  }

  let url = typeof body.url === "string" ? body.url.trim() : "";
  let token: string | null = typeof body.token === "string" ? body.token.trim() || null : null;
  let authProvider: AuthProvider | undefined;

  if (stored) {
    if (!url) url = stored.url ?? "";
    // Only fall back to the stored token when the body did not supply one.
    if (!token && typeof body.token !== "string") token = readMcpToken(stored);

    // A server configured for OAuth has no bearer token: test the stored
    // sign-in, or let the 401 report that a sign-in is needed.
    if (!token && stored.encryptedToken === null) {
      authProvider = createMcpAuthProvider({
        id: stored.id,
        userId,
        name: stored.name,
        url,
      });
    }
  }

  const urlError = validateMcpUrl(url);
  if (urlError) return NextResponse.json({ success: false, error: urlError }, { status: 400 });

  try {
    const result = await probeMcpServer({
      url,
      token,
      ...(authProvider ? { authProvider } : {}),
    });
    return NextResponse.json({
      success: true,
      serverName: result.serverName,
      serverVersion: result.serverVersion,
      instructions: result.instructions,
      tools: result.tools,
    });
  } catch (err) {
    console.error(`MCP connection test failed for user ${userId} (${url}):`, err);
    const needsAuth = isMcpOAuthRequired(err);
    if (needsAuth && stored) await cacheMcpOAuthChallenge(stored.id, err);
    return NextResponse.json(
      { success: false, error: describeProbeError(err), needsAuth },
      { status: 502 },
    );
  }
}

/** Run a stdio server's command in the account's workspace and list its tools. */
async function probeCommand(options: {
  userId: string;
  name: string | null;
  /** The stored command, for a saved server the form did not repeat. */
  command: string | null;
  cwd: string | null;
  /** The stored variables, which the form's own are added to. */
  storedEnv: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<NextResponse> {
  const { userId, body } = options;
  const typedCommand = typeof body.command === "string" ? body.command.trim() : "";
  const typedCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const command = typedCommand || options.command || "";
  const cwd = typedCwd || options.cwd || "";

  const commandError = validateMcpCommand(command);
  if (commandError)
    return NextResponse.json({ success: false, error: commandError }, { status: 400 });
  const cwdError = validateMcpCwd(cwd);
  if (cwdError) return NextResponse.json({ success: false, error: cwdError }, { status: 400 });

  const parsedEnv = parseMcpEnv(body.env);
  if (!parsedEnv.ok)
    return NextResponse.json({ success: false, error: parsedEnv.error }, { status: 400 });
  const env = { ...options.storedEnv, ...parsedEnv.value };

  if (!canExec()) {
    return NextResponse.json(
      {
        success: false,
        error: "This deployment has no workspace service, so a command server cannot run here.",
      },
      { status: 400 },
    );
  }

  const name =
    options.name?.trim() || (typeof body.name === "string" ? body.name.trim() : "") || "server";
  try {
    const result = await probeStdioMcpServer(
      { userId, name, command, cwd: cwd || null, env },
      { timeoutMs: STDIO_PROBE_TIMEOUT_MS },
    );
    return NextResponse.json({
      success: true,
      serverName: result.serverName,
      serverVersion: result.serverVersion,
      instructions: result.instructions,
      tools: result.tools,
    });
  } catch (err) {
    console.error(`MCP command test failed for user ${userId} (${command}):`, err);
    return NextResponse.json({ success: false, error: describeProbeError(err) }, { status: 502 });
  }
}
