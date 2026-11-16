import { describe, expect, it } from "vitest";
import {
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
} from "@earendil-works/pi-mcp/oauth";
import { describeMcpSignInError } from "@/lib/mcp/oauth-errors";

describe("describeMcpSignInError", () => {
  it("says what a hosted instance can do when its address is refused", () => {
    const problem = describeMcpSignInError(
      new OAuthRegistrationError(400, '{"error":"invalid_client_metadata"}'),
    );

    expect(problem.status).toBe(400);
    expect(problem.message).toContain("public address");
    expect(problem.message).toContain("access token");
    expect(problem.message).not.toContain("client_metadata");
  });

  it("names the code of a refusal it has no advice for", () => {
    const problem = describeMcpSignInError(
      new OAuthRegistrationError(403, '{"error":"registration_disabled"}'),
    );

    expect(problem.message).toContain("403");
    expect(problem.message).toContain("registration_disabled");
  });

  it("keeps the body out of the message when it is not JSON", () => {
    const problem = describeMcpSignInError(new OAuthRegistrationError(500, "<html>oops</html>"));

    expect(problem.message).toBe("The server refused to register Saale for sign-in (HTTP 500).");
  });

  it("explains the other ways a sign-in fails", () => {
    expect(
      describeMcpSignInError(new OAuthInsecureEndpointError("http://home.local")).message,
    ).toContain("HTTPS");
    expect(describeMcpSignInError(new OAuthIssuerMismatchError("a", "b")).message).toContain(
      "different address",
    );
    expect(describeMcpSignInError(new OAuthError("invalid_grant", "expired")).message).toBe(
      "The server rejected the sign-in (invalid_grant).",
    );
  });

  it("falls back to the error, then to a sentence", () => {
    expect(describeMcpSignInError(new Error("fetch failed")).message).toBe("fetch failed");
    expect(describeMcpSignInError("nope").message).toBe("The sign-in could not start.");
  });
});
