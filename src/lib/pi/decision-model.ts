/**
 * The decision model that judges the calls the `auto` policy would run.
 *
 * A decision model scores the options it is given instead of generating text:
 * one forward pass, one probability. Pi reaches one through
 * `ModelRegistry.classify()`, and llama.cpp serves it at `/v1/systemone` (see
 * `defineDecisionModel` in `models.ts`).
 *
 * The model sees the tool name and its arguments and nothing else, so a call it
 * cannot judge goes to the user as a normal approval. A wrong answer can cost an
 * approval card; it never turns into a yes on its own.
 */

import { createHash } from "node:crypto";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { splitModelReference } from "./model-ref";

/** A decision model, in the form the registry and the settings share. */
export interface DecisionModelRef {
  provider: string;
  id: string;
}

/** Probability of "risky" at which a call goes to the user instead. */
export const RISK_ASK_ABOVE = 0.6;

/**
 * How long a call waits for the model before the command checks decide.
 *
 * Generous on purpose: a llama-swap or router host swaps the model in on the
 * first request, which takes seconds where an answer takes milliseconds.
 */
export const DECISION_TIMEOUT_MS = 10_000;

/**
 * The same call, judged once.
 *
 * A verdict is a pure function of the model, the tool and its arguments, so a
 * remembered one is the answer the model would give again. What is stored is a
 * digest of the call: Redis holds no command text. The model is part of the
 * digest, so switching models misses rather than hits.
 */

/** Redis key prefix for a remembered verdict. */
const CACHE_PREFIX = "saale:decision:";

/** Longest serialized argument list a verdict is remembered for. */
export const CACHE_MAX_ARGS_CHARS = 2_000;

/** At or below this probability, a "safe" answer is worth remembering. */
export const CACHE_SAFE_BELOW = 0.2;

/**
 * How long a remembered verdict stands.
 *
 * A verdict only changes with the model, which is part of the key, so the entry
 * outlives the session it came from. The bound is for the one case the key
 * cannot see: a model replaced under the same id, such as a re-quantization.
 */
export const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The question every call is put to the model with. */
const RISK_QUESTION = {
  type: "bool" as const,
  instructions: "Would running this tool call without the user seeing it first be risky?",
  criteria: {
    true: "Destroys data, leaves the machine, or is hard to undo",
    false: "Reads, or changes something the user can undo",
  },
};

/** What the gate needs of Pi's registry: the lookup and the call. */
type ClassifierSource = Pick<ModelRegistry, "findOfType" | "classify">;

/** The answer the gate acts on. `null` means the model did not decide. */
export type ToolCallVerdict = "safe" | "risky";

/** `provider:model` as stored in the settings, or null when nothing is picked. */
export function parseDecisionModel(reference: string | null | undefined): DecisionModelRef | null {
  const parsed = splitModelReference(reference ?? null);
  return parsed ? { provider: parsed.provider, id: parsed.name } : null;
}

/** The instance default, for an account that has not picked one. */
export async function readInstanceDecisionModel(): Promise<DecisionModelRef | null> {
  const admin = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { approvalDecisionModel: true },
  });
  return parseDecisionModel(admin?.approvalDecisionModel);
}

/**
 * The decision model that governs one account's gate: its own pick, else the
 * instance default.
 *
 * Takes the stored value rather than the user id, so a caller that has already
 * read the settings row does not read it twice.
 */
export async function resolveApprovalDecisionModel(
  userPick: string | null | undefined,
): Promise<DecisionModelRef | null> {
  return parseDecisionModel(userPick) ?? (await readInstanceDecisionModel());
}

/**
 * Ask the decision model whether a call is safe to run without the user.
 *
 * @returns `safe` or `risky` when the model answered, `null` when it could not
 *   (no such model, an error, a timeout, an answer of the wrong shape).
 */
export async function judgeToolCall(options: {
  model: DecisionModelRef;
  registry: ClassifierSource;
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal | undefined;
}): Promise<ToolCallVerdict | null> {
  const { model, registry } = options;
  const classifier = registry.findOfType("classifier", model.provider, model.id);
  if (!classifier) {
    console.error(
      `The approval decision model ${model.provider}:${model.id} is not available; the command checks decide.`,
    );
    return null;
  }

  // A model that is gone answers nothing, so the cache is read only once it is
  // known to be registered.
  const cacheKey = decisionCacheKey(model, options.toolName, options.input);
  const remembered = await readCachedVerdict(cacheKey);
  if (remembered) return remembered;

  let result: Awaited<ReturnType<ClassifierSource["classify"]>>;
  try {
    result = await registry.classify(
      classifier,
      {
        // Tool arguments arrive as JSON, so they are JSON to send as state.
        state: { tool: options.toolName, arguments: options.input } as unknown as JsonObject,
        questions: { risky: RISK_QUESTION },
      },
      { signal: decisionSignal(options.signal) },
    );
  } catch (err) {
    console.error(`Failed to ask the approval decision model ${model.provider}:${model.id}:`, err);
    return null;
  }

  if (result.stopReason !== "stop") {
    console.error(
      `The approval decision model ${model.provider}:${model.id} did not answer (${result.errorMessage ?? result.stopReason}); the command checks decide.`,
    );
    return null;
  }

  const answer = result.answers.risky;
  if (answer?.type !== "bool") {
    console.error(
      `The approval decision model ${model.provider}:${model.id} answered no "risky" question; the command checks decide.`,
    );
    return null;
  }

  const verdict: ToolCallVerdict = answer.probability >= RISK_ASK_ABOVE ? "risky" : "safe";
  // Only a confident "safe" is remembered: a borderline answer keeps being
  // judged fresh, and a "risky" one asks either way.
  if (verdict === "safe" && answer.probability <= CACHE_SAFE_BELOW) {
    await rememberVerdict(cacheKey, verdict);
  }
  return verdict;
}

/**
 * The cache key for one decision, or null when the call is too long to
 * remember.
 */
function decisionCacheKey(
  model: DecisionModelRef,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const args = JSON.stringify(input ?? {});
  if (args.length > CACHE_MAX_ARGS_CHARS) return null;
  const digest = createHash("sha256")
    .update(`${model.provider}:${model.id}\n${toolName}\n${args}`)
    .digest("hex");
  return `${CACHE_PREFIX}${digest}`;
}

/** A verdict remembered for this call, if one is still fresh. */
async function readCachedVerdict(key: string | null): Promise<ToolCallVerdict | null> {
  if (!key) return null;
  try {
    const cached = await getRedis().get(key);
    return cached === "safe" || cached === "risky" ? cached : null;
  } catch (err) {
    console.error("Failed to read a remembered approval verdict:", err);
    return null;
  }
}

/** Remember a verdict. A Redis failure only costs the next call its lookup. */
async function rememberVerdict(key: string | null, verdict: ToolCallVerdict): Promise<void> {
  if (!key) return;
  try {
    await getRedis().setex(key, CACHE_TTL_SECONDS, verdict);
  } catch (err) {
    console.error("Failed to remember an approval verdict:", err);
  }
}

/** The caller's abort, and the wait this module allows on top of it. */
function decisionSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
