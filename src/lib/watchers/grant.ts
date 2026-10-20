/**
 * A watcher's tool grant: which tool calls the user approved for one script.
 *
 * A chat approves a script's calls in front of the user, per run, and the grant
 * dies with the call that owned it (`approval-scope.ts`). A watcher has nobody
 * to ask at tick time, so the approval moves to the moment the watcher is
 * created: the user reads the script once and confirms the calls it needs, and
 * that decision is recorded on the row.
 *
 * What the record has to pin down is the *pair*. a tool list is only meaningful
 * for the script it was read from. so the grant stores the script's sha256
 * alongside the names. A script that changed under the grant is refused rather
 * than run on an approval issued for different code; anything else makes the
 * grant a blanket approval for whatever the script later becomes.
 *
 * Which calls need consent is `ask` plus `auto`. `ask` would have asked the user
 * on its own, and `auto` is the command-aware policies (`bash`, `infra_exec`)
 * whose decision is made from the command at the call. and a tick has no
 * call-time decision-maker, so the consent has to be given up front instead.
 */

import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readScriptToolReferences, resolveReferencedTools } from "@/lib/pi/codemode-script";
import { resolveToolPolicy } from "@/lib/pi/tool-policy";
import { CODEMODE_TOOL_NAME, type ToolPolicy } from "@/lib/pi/tool-infos";

/** Policies that need the user's consent before a watcher script may run them. */
const CONSENT_POLICIES: readonly ToolPolicy[] = ["ask", "auto"];

/** The user's per-tool policies, as `AppSettings.toolPolicies` stores them. */
export type ToolPolicies = Record<string, string> | null | undefined;

/**
 * The hash a watcher carries until a person has approved its script.
 *
 * Stored in place of the script's real hash, which makes the watcher read as
 * unapproved everywhere it matters: `needsScriptApproval` is true, so the UI
 * offers the approval, and the next tick is refused. It is the same
 * representation a script edited after approval gets. to a tick, "never
 * approved" and "changed since approval" are one thing: a stored hash that does
 * not describe this script.
 *
 * No sha256 is the empty string, so this cannot collide with a real one.
 */
export const UNAPPROVED_SCRIPT_HASH = "";

/** The script's identity, as stored on the watcher. */
export function hashScript(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

/** The agreed form of the tool-approval policy for one call. */
function policyOf(toolName: string, toolPolicies: ToolPolicies): ToolPolicy {
  return resolveToolPolicy(toolName, { toolPolicies });
}

/** Whether a policy needs the user's consent to run unattended. */
function needsConsent(policy: ToolPolicy): boolean {
  return CONSENT_POLICIES.includes(policy);
}

/**
 * The tools a watcher script may call, and their names.
 *
 * Everything the user has enabled, minus whatever they set to `off`: a tool the
 * user turned off is not merely gated, it is absent, so no grant can resurrect
 * it. `codemode` is absent too. a script cannot start a script.
 *
 * This is the single answer to "what may this script reach": the tick's tool
 * table, the consent list the user approves, and the grant check all read it,
 * so none of them can disagree about the set.
 *
 * Exposure is deliberately not consulted. It governs how a *model* reaches a
 * tool, and a watcher has no model in the loop. the script is the only caller.
 */
export function watcherToolAccess(options: {
  tools: readonly ToolDefinition[];
  toolPolicies: ToolPolicies;
}): { callable: ToolDefinition[]; callableNames: string[] } {
  const callable = options.tools.filter(
    (tool) =>
      tool.name !== CODEMODE_TOOL_NAME && policyOf(tool.name, options.toolPolicies) !== "off",
  );
  return { callable, callableNames: callable.map((tool) => tool.name) };
}

/**
 * The tools the user must consent to for this script.
 *
 * A static script names what it reaches, so consent covers exactly those calls.
 * A script that reaches tools by a computed name (`tools[someVar]`) or through
 * the catalog cannot be read from its source, so consent covers every callable
 * tool. broader, but honest: it is what "this script may run anything I can
 * run" actually means, and the dialog says so.
 */
export function consentFor(options: {
  script: string;
  callableNames: readonly string[];
  toolPolicies: ToolPolicies;
}): { scriptHash: string; grantedTools: string[]; grantAll: boolean } {
  const references = readScriptToolReferences(options.script);

  const covered = references.dynamic
    ? [...options.callableNames]
    : resolveReferencedTools(references.keys, options.callableNames);

  const grantedTools = covered
    .filter((name) => needsConsent(policyOf(name, options.toolPolicies)))
    .sort();

  return {
    scriptHash: hashScript(options.script),
    grantedTools,
    grantAll: references.dynamic,
  };
}

/** What a stored grant says, as the row holds it. */
export interface StoredGrant {
  script: string;
  scriptHash: string;
  grantedTools: readonly string[];
  grantAll: boolean;
}

/** Why a stored grant no longer covers what the script would do. */
export interface GrantViolation {
  reason: string;
  /** Tools the script now needs consent for that the grant does not carry. */
  missing: string[];
}

/**
 * Check a stored grant against the script as it is now, the tools it could call
 * now, and the user's policies as they are now.
 *
 * Three things can move under a grant, and all three mean the approval no longer
 * describes what would run:
 *
 * - the script was edited (its hash changed);
 * - the tool set changed, so a dynamic script reaches something new;
 * - a policy changed, so a call that used to be `allow` now needs consent.
 *
 * @returns null when the grant holds, else the reason it does not.
 */
export function checkGrant(options: {
  grant: StoredGrant;
  callableNames: readonly string[];
  toolPolicies: ToolPolicies;
}): GrantViolation | null {
  const { grant } = options;

  if (grant.scriptHash === UNAPPROVED_SCRIPT_HASH) {
    return { reason: "The script has not been approved by the user yet.", missing: [] };
  }

  if (hashScript(grant.script) !== grant.scriptHash) {
    return { reason: "The script changed after it was approved.", missing: [] };
  }

  const callable = new Set(options.callableNames);

  // A tool switched off (or a whole category disabled) does not merely stop
  // asking. it leaves the tool set. The approved call would fail mid-script,
  // which reads as "the watcher quietly stopped working", so it is refused
  // here instead.
  const unavailable = grant.grantedTools.filter((name) => !callable.has(name));
  if (unavailable.length > 0) {
    return {
      reason: "Tools approved for this script are no longer available to it.",
      missing: unavailable,
    };
  }

  const granted = new Set(grant.grantedTools);
  const required = consentFor({
    script: grant.script,
    callableNames: options.callableNames,
    toolPolicies: options.toolPolicies,
  }).grantedTools;

  const missing = required.filter((name) => !granted.has(name));
  if (missing.length > 0) {
    return {
      reason: "The script reaches tools that were not approved for it (or their policy changed).",
      missing,
    };
  }

  return null;
}
