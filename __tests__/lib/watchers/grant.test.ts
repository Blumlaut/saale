import { describe, it, expect } from "vitest";
import { checkGrant, consentFor, hashScript, watcherToolAccess } from "@/lib/watchers/grant";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * A watcher's grant is what lets a script run unattended, so the cases here are
 * the ones where an approval could otherwise outlive what it described: a
 * rewritten script, a tool the user turned off, and a policy that changed after
 * the fact.
 */

/** A tool definition carrying only what the grant logic reads. */
function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
}

const CALLABLE = ["mail_list", "mail_send", "bash", "read", "infra_exec"];

describe("watcherToolAccess", () => {
  it("keeps enabled tools and drops the ones the user turned off", () => {
    const { callableNames } = watcherToolAccess({
      tools: CALLABLE.map(tool),
      toolPolicies: { mail_send: "off", bash: "off" },
    });

    expect(callableNames).toEqual(["mail_list", "read", "infra_exec"]);
  });

  it("never offers the codemode tool, so a watcher script cannot start a script", () => {
    const { callableNames } = watcherToolAccess({
      tools: [...CALLABLE.map(tool), tool("codemode")],
      toolPolicies: null,
    });

    // The registry does not ship `codemode` — it comes from Pi's extension — so
    // this pins that a future rewiring cannot smuggle it in.
    expect(callableNames).not.toContain("codemode");
  });
});

describe("consentFor", () => {
  it("covers only the calls a static script reaches that would ask on their own", () => {
    const consent = consentFor({
      script: [
        "const mails = await tools.mail_list({ folder: 'inbox' });",
        "if (mails.length) await tools.mail_send({ to: 'x' });",
        "return mails.length;",
      ].join("\n"),
      callableNames: CALLABLE,
      toolPolicies: null,
    });

    // `mail_list` is `allow` (it would never ask), `mail_send` is `ask`.
    expect(consent.grantedTools).toEqual(["mail_send"]);
    expect(consent.grantAll).toBe(false);
  });

  it("demands consent for command-aware tools whose decision normally waits for the call", () => {
    const consent = consentFor({
      script: "return await tools.bash({ command: 'systemctl status nginx' });",
      callableNames: CALLABLE,
      toolPolicies: null,
    });

    // `bash` is `auto`: in a chat it decides from the command at the call, and a
    // tick has no call-time decision — so the consent has to be given up front.
    expect(consent.grantedTools).toEqual(["bash"]);
  });

  it("covers every callable tool when the script reaches tools by a computed name", () => {
    const consent = consentFor({
      script: "const n = 'mail_send';\nreturn await tools[n]({});",
      callableNames: CALLABLE,
      toolPolicies: null,
    });

    expect(consent.grantAll).toBe(true);
    // `mail_list` is `allow`, so it needs no consent even here.
    expect(consent.grantedTools).toEqual(["bash", "infra_exec", "mail_send"]);
  });

  it("honors the user's own policy over the catalog default", () => {
    const consent = consentFor({
      script: "return await tools.mail_list({});",
      callableNames: CALLABLE,
      toolPolicies: { mail_list: "ask" },
    });

    expect(consent.grantedTools).toEqual(["mail_list"]);
  });

  it("binds the consent to the exact script it was read from", () => {
    const one = consentFor({ script: "return 1;", callableNames: CALLABLE, toolPolicies: null });
    const two = consentFor({
      script: "return await tools.mail_send({});",
      callableNames: CALLABLE,
      toolPolicies: null,
    });

    expect(one.scriptHash).not.toEqual(two.scriptHash);
    expect(one.scriptHash).toEqual(hashScript("return 1;"));
  });
});

describe("checkGrant", () => {
  const approvedScript = "return await tools.mail_send({ to: 'a' });";

  function approved(overrides: Partial<Parameters<typeof checkGrant>[0]["grant"]> = {}) {
    const consent = consentFor({
      script: approvedScript,
      callableNames: CALLABLE,
      toolPolicies: null,
    });
    return {
      grant: {
        script: approvedScript,
        scriptHash: consent.scriptHash,
        grantedTools: consent.grantedTools,
        grantAll: consent.grantAll,
        ...overrides,
      },
      callableNames: CALLABLE,
      toolPolicies: null,
    };
  }

  it("holds while nothing the approval described has moved", () => {
    expect(checkGrant(approved())).toBeNull();
  });

  it("refuses a script that changed after it was approved", () => {
    const violation = checkGrant({
      ...approved(),
      grant: {
        ...approved().grant,
        script: `${approvedScript}\nawait tools.bash({ command: 'rm -rf /' });`,
      },
    });

    expect(violation?.reason).toContain("changed after it was approved");
  });

  it("refuses when a policy moved a call into needing consent", () => {
    const script = "return await tools.read({ path: '/etc/hosts' });";
    // At approval `read` is `allow`, so nothing needed consenting to.
    const consent = consentFor({ script, callableNames: CALLABLE, toolPolicies: null });
    expect(consent.grantedTools).toEqual([]);

    const violation = checkGrant({
      grant: {
        script,
        scriptHash: consent.scriptHash,
        grantedTools: consent.grantedTools,
        grantAll: consent.grantAll,
      },
      callableNames: CALLABLE,
      toolPolicies: { read: "ask" },
    });

    // The user now wants to be asked about reads; this script can no longer run
    // unattended until they say yes to that.
    expect(violation?.missing).toEqual(["read"]);
  });

  it("refuses a dynamic script whose reachable tool set grew", () => {
    const dynamicScript = "const n = load('name');\nreturn await tools[n]({});";
    const consent = consentFor({
      script: dynamicScript,
      callableNames: CALLABLE,
      toolPolicies: null,
    });

    // At approval the script could reach these; a tool added later that needs
    // consent is reached by the same computed name and was never approved.
    const violation = checkGrant({
      grant: {
        script: dynamicScript,
        scriptHash: consent.scriptHash,
        grantedTools: consent.grantedTools,
        grantAll: consent.grantAll,
      },
      callableNames: [...CALLABLE, "settings_set"],
      toolPolicies: null,
    });

    expect(violation?.missing).toEqual(["settings_set"]);
  });

  it("refuses an approved call the user has since turned off", () => {
    const script = "return await tools.mail_send({});";
    const consent = consentFor({ script, callableNames: CALLABLE, toolPolicies: null });

    const violation = checkGrant({
      grant: {
        script,
        scriptHash: consent.scriptHash,
        grantedTools: consent.grantedTools,
        grantAll: consent.grantAll,
      },
      callableNames: CALLABLE.filter((name) => name !== "mail_send"),
      toolPolicies: { mail_send: "off" },
    });

    // Turning it off removes the tool, so the approved call would fail mid-script
    // — refused up front, with the reason a user can act on.
    expect(violation?.missing).toEqual(["mail_send"]);
    expect(violation?.reason).toContain("no longer available");
  });
});
