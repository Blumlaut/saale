import { describe, it, expect, beforeEach } from "vitest";
import {
  clearSessionAbort,
  requestSessionAbort,
  wasSessionAbortRequested,
} from "@/lib/pi/abort-request";

describe("abort request record", () => {
  beforeEach(() => {
    clearSessionAbort("user-1", "session-1");
    clearSessionAbort("user-1", "session-2");
    clearSessionAbort("user-2", "session-1");
  });

  it("reports a request only for the session it was made for", () => {
    requestSessionAbort("user-1", "session-1");

    expect(wasSessionAbortRequested("user-1", "session-1")).toBe(true);
    expect(wasSessionAbortRequested("user-1", "session-2")).toBe(false);
  });

  it("keeps users isolated", () => {
    requestSessionAbort("user-1", "session-1");

    expect(wasSessionAbortRequested("user-2", "session-1")).toBe(false);
  });

  it("forgets a request once cleared", () => {
    requestSessionAbort("user-1", "session-1");
    clearSessionAbort("user-1", "session-1");

    expect(wasSessionAbortRequested("user-1", "session-1")).toBe(false);
  });

  it("is a no-op when clearing an unknown session", () => {
    expect(() => clearSessionAbort("nobody", "nothing")).not.toThrow();
  });
});
