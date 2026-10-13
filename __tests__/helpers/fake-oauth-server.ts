/**
 * A minimal OAuth 2.1 authorization server for tests.
 *
 * Serves the discovery documents, dynamic client registration, the
 * authorization endpoint (which redirects straight back with a code) and the
 * token endpoint, so an MCP sign-in can be driven end to end without a browser.
 */

import http from "node:http";

export interface FakeOAuthServer {
  url: string;
  /** The access token every grant issues. */
  accessToken: string;
  /** The refresh token the code exchange returns. */
  refreshToken: string;
  /** Authorization requests the server received, in order. */
  authorizationRequests: URL[];
  /** Token requests, as parsed form bodies. */
  tokenRequests: Record<string, string>[];
  /** Client metadata registrations the server received. */
  registrationRequests: Record<string, unknown>[];
  /** The protected resource the metadata advertises; set once the MCP server exists. */
  setResourceUrl(url: string): void;
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

export async function startFakeOAuthServer(
  options: { accessToken?: string } = {},
): Promise<FakeOAuthServer> {
  const accessToken = options.accessToken ?? "access-token-1";
  const refreshToken = "refresh-token-1";

  let resourceUrl = "";
  let codeCounter = 0;
  const issuedCodes = new Set<string>();
  const authorizationRequests: URL[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const registrationRequests: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const requestUrl = new URL(req.url ?? "/", origin);

      switch (requestUrl.pathname) {
        case "/.well-known/oauth-protected-resource":
          json(res, 200, { resource: resourceUrl, authorization_servers: [origin] });
          return;

        case "/.well-known/oauth-authorization-server":
          json(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;

        case "/register": {
          const registration = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          registrationRequests.push(registration);
          json(res, 200, {
            client_id: "saale-test-client",
            redirect_uris: registration.redirect_uris,
            token_endpoint_auth_method: "none",
          });
          return;
        }

        case "/authorize": {
          authorizationRequests.push(requestUrl);
          const code = `code-${++codeCounter}`;
          issuedCodes.add(code);

          const redirect = new URL(requestUrl.searchParams.get("redirect_uri") ?? origin);
          redirect.searchParams.set("code", code);
          const state = requestUrl.searchParams.get("state");
          if (state) redirect.searchParams.set("state", state);

          res.writeHead(302, { location: redirect.href });
          res.end();
          return;
        }

        case "/token": {
          const params = new URLSearchParams(await readBody(req));
          const body = Object.fromEntries(params) as Record<string, string>;
          tokenRequests.push(body);

          if (body.grant_type === "authorization_code" && !issuedCodes.has(body.code ?? "")) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          issuedCodes.delete(body.code ?? "");

          json(res, 200, {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3_600,
            refresh_token: refreshToken,
          });
          return;
        }

        default:
          res.writeHead(404);
          res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OAuth server has no port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    accessToken,
    refreshToken,
    authorizationRequests,
    tokenRequests,
    registrationRequests,
    setResourceUrl: (url) => {
      resourceUrl = url;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
