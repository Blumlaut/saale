import { describe, it, expect } from "vitest";
import {
  UNKNOWN_PROVIDER_ERROR,
  extractProviderError,
  formatProviderError,
} from "@/lib/pi/provider-error";

describe("extractProviderError", () => {
  it("returns the error message for a failed assistant message", () => {
    expect(
      extractProviderError({
        stopReason: "error",
        errorMessage: '400: {"message":"Invalid max_tokens value"}',
      }),
    ).toBe('400: {"message":"Invalid max_tokens value"}');
  });

  it("falls back to a readable message when the provider gives none", () => {
    expect(extractProviderError({ stopReason: "error" })).toBe(UNKNOWN_PROVIDER_ERROR);
    expect(extractProviderError({ stopReason: "error", errorMessage: "   " })).toBe(
      UNKNOWN_PROVIDER_ERROR,
    );
  });

  it("ignores successful turns", () => {
    expect(extractProviderError({ stopReason: "stop" })).toBeNull();
    expect(extractProviderError({ stopReason: "length", errorMessage: "truncated" })).toBeNull();
  });

  it("ignores aborts — stopping a run is not a provider failure", () => {
    expect(
      extractProviderError({ stopReason: "aborted", errorMessage: "Request was aborted" }),
    ).toBe(null);
  });

  it("handles a missing message", () => {
    expect(extractProviderError(undefined)).toBeNull();
    expect(extractProviderError(null)).toBeNull();
  });
});

describe("formatProviderError", () => {
  it("splits the status off an OpenAI-style JSON error", () => {
    expect(formatProviderError('400: {"message":"Invalid max_tokens value","type":"x"}')).toEqual({
      status: 400,
      message: "Invalid max_tokens value",
      shortened: true,
    });
  });

  it("reads nested Anthropic-style error bodies", () => {
    expect(
      formatProviderError(
        '401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toEqual({ status: 401, message: "invalid x-api-key", shortened: true });
  });

  it("passes a plain network error through unchanged", () => {
    expect(formatProviderError("fetch failed")).toEqual({
      message: "fetch failed",
      shortened: false,
    });
  });

  it("keeps a non-JSON body verbatim, status and all", () => {
    expect(formatProviderError("502: <html>Bad gateway</html>")).toEqual({
      status: 502,
      message: "<html>Bad gateway</html>",
      shortened: false,
    });
  });

  it("does not lose a body that has no message field", () => {
    expect(formatProviderError('500: {"code":"internal"}')).toEqual({
      status: 500,
      message: '{"code":"internal"}',
      shortened: false,
    });
  });

  it("handles a bare status with no body", () => {
    expect(formatProviderError("503:")).toEqual({
      status: 503,
      message: "503:",
      shortened: false,
    });
  });

  it("handles empty input without throwing", () => {
    expect(formatProviderError("")).toEqual({ message: "", shortened: false });
  });

  it("does not treat a 4-digit number as a status", () => {
    expect(formatProviderError("1234: oops")).toEqual({ message: "1234: oops", shortened: false });
  });
});
