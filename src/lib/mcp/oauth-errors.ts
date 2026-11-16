/**
 * What went wrong with a sign-in, in words the person reading the sheet can act
 * on. Pi's errors carry the authorization server's own JSON, which says
 * nothing to someone who just pressed Sign in.
 */

import {
  McpSignInCancelledError,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
} from "@earendil-works/pi-mcp/oauth";

export interface McpSignInProblem {
  /** Status the sign-in route answers with. Starting a sign-in failed, so 400. */
  status: number;
  message: string;
}

/** Codes a server sends when it will not let a hosted app register. */
const REFUSED_REDIRECT_CODES = ["invalid_redirect_uri", "invalid_client_metadata"];

/** The error code out of a registration body, or null for a body without one. */
export function registrationErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/** Why a sign-in could not start or complete, as the settings sheet shows it. */
export function describeMcpSignInError(err: unknown): McpSignInProblem {
  if (err instanceof OAuthRegistrationError) {
    const code = registrationErrorCode(err.body);
    if (code && REFUSED_REDIRECT_CODES.includes(code)) {
      return {
        status: 400,
        message:
          "This server will not sign Saale in from a public address. It accepts only apps that run on the same machine as the browser. Use an access token instead, if the server issues one.",
      };
    }
    return {
      status: 400,
      message: `The server refused to register Saale for sign-in (HTTP ${err.status}${code ? `, ${code}` : ""}).`,
    };
  }

  if (err instanceof OAuthInsecureEndpointError) {
    return {
      status: 400,
      message: "The server's sign-in address is not HTTPS, so Saale will not send it credentials.",
    };
  }

  if (err instanceof OAuthIssuerMismatchError) {
    return {
      status: 400,
      message: "The sign-in answer came from a different address than the server announced.",
    };
  }

  if (err instanceof OAuthError) {
    return { status: 400, message: `The server rejected the sign-in (${err.code}).` };
  }

  if (err instanceof McpSignInCancelledError) {
    return { status: 400, message: "The sign-in was cancelled." };
  }

  return {
    status: 400,
    message: err instanceof Error ? err.message : "The sign-in could not start.",
  };
}
