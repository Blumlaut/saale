import { describe, it, expect } from "vitest";
import {
  grantApprovalScope,
  isApprovalScopeGranted,
  releaseApprovalScope,
} from "@/lib/pi/approval-scope";

/**
 * A scope is what makes one approval cover the calls a tool goes on to make.
 * The id shape is Pi's: a nested call is `<calling id>/<n>`, so a grant has to
 * cover the calls nested in it, and only those.
 */

const SESSION = "session-scope";

describe("approval scopes", () => {
  it("covers a call nested in the approved one", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-a",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-a/1", toolName: "mail_send" }),
    ).toBe(true);
    // Deeper nesting is still nested.
    expect(
      isApprovalScopeGranted({
        sessionId: SESSION,
        toolCallId: "call-a/2/1",
        toolName: "mail_send",
      }),
    ).toBe(true);
  });

  it("covers only the tools the approval named", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-b",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-b/1", toolName: "mail_send" }),
    ).toBe(true);
    expect(
      isApprovalScopeGranted({
        sessionId: SESSION,
        toolCallId: "call-b/1",
        toolName: "mail_delete",
      }),
    ).toBe(false);
  });

  it("does not cover a call that is not nested in the approved one", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-c",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    // The approved call itself is covered, and a call nested in it  but not a
    // call whose id merely starts with the same characters.
    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-c", toolName: "mail_send" }),
    ).toBe(true);
    expect(
      isApprovalScopeGranted({
        sessionId: SESSION,
        toolCallId: "call-cx/1",
        toolName: "mail_send",
      }),
    ).toBe(false);
  });

  it("keeps sessions apart", () => {
    grantApprovalScope({
      sessionId: "session-one",
      toolCallId: "call-d",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    expect(
      isApprovalScopeGranted({
        sessionId: "session-two",
        toolCallId: "call-d/1",
        toolName: "mail_send",
      }),
    ).toBe(false);
  });

  it("drops the grant when the approved call finishes", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-e",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });
    releaseApprovalScope(SESSION, "call-e");

    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-e/1", toolName: "mail_send" }),
    ).toBe(false);
  });

  it("stops covering a call once the approval window has passed", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-f",
      tools: ["mail_send"],
      expiresAt: Date.now() - 1,
    });

    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-f/1", toolName: "mail_send" }),
    ).toBe(false);
  });

  it("ignores a grant that covers nothing", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-g",
      tools: [],
      expiresAt: Date.now() + 60_000,
    });

    expect(
      isApprovalScopeGranted({ sessionId: SESSION, toolCallId: "call-g/1", toolName: "mail_send" }),
    ).toBe(false);
  });

  it("covers a nested call from the nearest granted ancestor", () => {
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-h",
      tools: ["web_search"],
      expiresAt: Date.now() + 60_000,
    });
    grantApprovalScope({
      sessionId: SESSION,
      toolCallId: "call-h/1",
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    expect(
      isApprovalScopeGranted({
        sessionId: SESSION,
        toolCallId: "call-h/1/1",
        toolName: "mail_send",
      }),
    ).toBe(true);
    expect(
      isApprovalScopeGranted({
        sessionId: SESSION,
        toolCallId: "call-h/1/1",
        toolName: "web_search",
      }),
    ).toBe(true);
  });
});
