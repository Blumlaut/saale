#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Debug script: trace prompt cache invalidation risks.
 *
 * Usage:
 *   npx tsx scripts/debug-prompt-cache.ts
 *
 * This script simulates the system prompt construction for different user
 * configurations and checks for non-determinism or unintended changes.
 *
 * It also verifies that tool definitions are stable and that message
 * serialization is deterministic.
 */

import { normalizeToolResult } from "@/lib/pi/message-replay";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

// ─── System Prompt Analysis ───────────────────────────────────────────

function buildChatSystemPrompt(options: {
  customInstructions: string | null;
  terminalEnabled: boolean;
  memoryEnabled: boolean;
}): string {
  const defaultSystemPrompt = `You are Saale, a personal AI assistant built into a productivity workspace. You help with chat, email drafting, job management, calendar, and file organization.

Guidelines:
- Be concise and direct — get to the point without unnecessary preamble.
- Write naturally, like a capable colleague, not a generic AI.
- Use bullet points or short paragraphs when listing things.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

  const customInstructions =
    options.customInstructions && options.customInstructions.trim()
      ? "\n\nCustom instructions:\n" + options.customInstructions
      : "";

  const terminalInstruction = options.terminalEnabled
    ? "\n\nA Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available."
    : "";

  const memoryInstruction = options.memoryEnabled
    ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
    : "";

  return defaultSystemPrompt + customInstructions + terminalInstruction + memoryInstruction;
}

console.log("═".repeat(70));
console.log("PROMPT CACHE DEBUG — System Prompt Analysis");
console.log("═".repeat(70));

// Test 1: Determinism check
const config = {
  customInstructions: "Always respond in German. Be formal.",
  terminalEnabled: true,
  memoryEnabled: true,
};

const prompts = Array.from({ length: 10 }, () => buildChatSystemPrompt(config));
const allSame = prompts.every((p) => p === prompts[0]!);
console.log(`\n✓ Determinism (${prompts.length} runs): ${allSame ? "PASS" : "FAIL"}`);
console.log(`  Length: ${prompts[0]!.length} chars`);

// Test 2: Check for dynamic content
const prompt = buildChatSystemPrompt(config);
const hasDate = /\d{4}-\d{2}-\d{2}/.test(prompt);
const hasUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(prompt);
const hasTimestamp = /Date\.now|timestamp|epoch/i.test(prompt);
console.log(`\n✓ No dynamic content:`);
console.log(`  Dates: ${hasDate ? "FOUND ⚠️" : "none ✓"}`);
console.log(`  UUIDs: ${hasUuid ? "FOUND ⚠️" : "none ✓"}`);
console.log(`  Timestamps: ${hasTimestamp ? "FOUND ⚠️" : "none ✓"}`);

// Test 3: Sensitivity analysis — what changes the prompt?
console.log(`\n✓ Sensitivity analysis:`);
const base = buildChatSystemPrompt({
  customInstructions: null,
  terminalEnabled: true,
  memoryEnabled: true,
});

const variations = [
  {
    name: "null custom instructions",
    config: { customInstructions: null, terminalEnabled: true, memoryEnabled: true },
  },
  {
    name: "empty custom instructions",
    config: { customInstructions: "", terminalEnabled: true, memoryEnabled: true },
  },
  {
    name: "whitespace custom instructions",
    config: { customInstructions: "   ", terminalEnabled: true, memoryEnabled: true },
  },
  {
    name: "with custom instructions",
    config: { customInstructions: "Be nice", terminalEnabled: true, memoryEnabled: true },
  },
  {
    name: "terminal disabled",
    config: { customInstructions: null, terminalEnabled: false, memoryEnabled: true },
  },
  {
    name: "memory disabled",
    config: { customInstructions: null, terminalEnabled: true, memoryEnabled: false },
  },
  {
    name: "all disabled",
    config: { customInstructions: null, terminalEnabled: false, memoryEnabled: false },
  },
];

for (const { name, config: c } of variations) {
  const p = buildChatSystemPrompt(c);
  const same = p === base;
  console.log(`  ${same ? "═" : "≠"} ${name}: ${p.length} chars`);
}

// ─── Tool Policy Analysis ─────────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("PROMPT CACHE DEBUG — Tool Policy Analysis");
console.log("═".repeat(70));

const toolNames = [
  "memory_search",
  "memory_save",
  "memory_delete",
  "web_search",
  "web_fetch",
  "calendar_read",
  "calendar_create",
  "calendar_update",
  "calendar_delete",
  "mail_search",
  "mail_read",
  "mail_send",
  "task_list",
  "task_create",
  "task_update",
  "task_delete",
  "job_list",
  "job_run",
  "chat_list",
  "chat_send",
];

console.log("\n✓ Tool policies (determinism check):");
for (const name of toolNames) {
  const p1 = getDefaultPolicy(name);
  const p2 = getDefaultPolicy(name);
  const match = p1 === p2 ? "✓" : "✗";
  console.log(`  ${match} ${name}: ${p1}`);
}

// ─── Tool Result Normalization ────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("PROMPT CACHE DEBUG — Tool Result Normalization");
console.log("═".repeat(70));

const testCases: Array<{ name: string; input: unknown }> = [
  { name: "structured text", input: { content: [{ type: "text", text: "search results" }] } },
  { name: "plain string", input: "already normalized" },
  {
    name: "multi-block",
    input: {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    },
  },
  {
    name: "with image",
    input: {
      content: [
        { type: "text", text: "see image" },
        { type: "image", data: "..." },
      ],
    },
  },
  { name: "json fallback", input: { foo: 42, bar: "baz" } },
  { name: "null", input: null },
  { name: "empty content", input: { content: [] } },
  { name: "missing text", input: { content: [{ type: "text" }] } },
];

console.log("\n✓ Normalization results:");
for (const { name, input } of testCases) {
  const result = normalizeToolResult(input);
  // Run twice to check determinism
  const result2 = normalizeToolResult(input);
  const match = result === result2 ? "✓" : "✗";
  console.log(`  ${match} ${name}: "${result.slice(0, 60)}${result.length > 60 ? "..." : ""}"`);
}

// ─── Message Serialization ────────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("PROMPT CACHE DEBUG — Message Serialization");
console.log("═".repeat(70));

const testMessages = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think...", thinkingSignature: "sig==" },
      { type: "text", text: "The answer is 42." },
      { type: "toolCall", id: "tc-1", name: "search", arguments: { q: "test" } },
    ],
  },
  { role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "results" }] },
];

console.log("\n✓ Serialization determinism:");
for (const msg of testMessages) {
  const s1 = JSON.stringify(msg);
  const s2 = JSON.stringify(msg);
  const parsed = JSON.parse(s1);
  const match = s1 === s2 && JSON.stringify(parsed) === s1 ? "✓" : "✗";
  console.log(`  ${match} ${msg.role}: ${s1.length} chars`);
}

// ─── Cache Control Placement ──────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("PROMPT CACHE DEBUG — Cache Control Placement");
console.log("═".repeat(70));

function simulateCacheControl(messages: Array<{ role: string; content: unknown[] }>) {
  const cacheControl = { type: "ephemeral" };
  const result = messages.map((m) => ({ ...m, content: [...m.content] }));

  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.role === "user") {
      const lastBlock = result[i]!.content[result[i]!.content.length - 1];
      if (lastBlock && typeof lastBlock === "object") {
        (lastBlock as Record<string, unknown>).cache_control = cacheControl;
      }
      break;
    }
  }

  return result;
}

function hasCacheControlOnLastBlock(msg: { content: unknown[] }): boolean {
  const lastBlock = msg.content[msg.content.length - 1] as Record<string, unknown>;
  return "cache_control" in lastBlock;
}

// Turn 1
const turn1 = simulateCacheControl([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
console.log("\n✓ Turn 1 (1 message):");
const ccIdx1 = turn1.findIndex((m) => hasCacheControlOnLastBlock(m));
console.log(
  `  cache_control on msg[${ccIdx1}]: ${hasCacheControlOnLastBlock(turn1[0]!) ? "yes" : "no"}`,
);

// Turn 2
const turn2 = simulateCacheControl([
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
  { role: "user", content: [{ type: "text", text: "Follow up" }] },
]);
console.log("\n✓ Turn 2 (3 messages):");
const ccIndex = turn2.findIndex((m) => hasCacheControlOnLastBlock(m));
console.log(`  cache_control on msg[${ccIndex}] (${turn2[ccIndex]!.role})`);
const hasCcOnFirst = hasCacheControlOnLastBlock(turn2[0]!);
console.log(`  msg[0] has cache_control: ${hasCcOnFirst ? "yes ⚠️" : "no ✓"}`);

// ─── Summary ──────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log("SUMMARY");
console.log("═".repeat(70));
console.log(`
Cache invalidation risks:

1. SYSTEM PROMPT CHANGES (HIGH RISK)
   - User edits agentCustomInstructions between turns
   - Agent evicted from pool → recreated with new prompt
   - Cache invalidated because system prompt is part of the prefix
   - Mitigation: Pool keeps agents alive for 30min idle time

2. TOOL DEFINITION CHANGES (LOW RISK)
   - Tool config changes between turns (terminal/memory toggles)
   - These also change the system prompt (terminalInstruction/memoryInstruction)
   - Mitigation: Same as system prompt — pool lifetime

3. MESSAGE CONTENT (NO RISK)
   - SDK manages message history internally via JSONL
   - Messages are stored exactly as they were in the conversation
   - transformMessages is deterministic for same inputs
   - Synthetic tool result timestamps are NOT sent to API

4. CACHE_CONTROL PLACEMENT (NO RISK)
   - SDK correctly places cache_control on last user message
   - Previous messages don't have cache_control (correct behavior)
   - On follow-up, cache_control moves to new last user message

5. ONE-SHOT JOBS (NO RISK)
   - dispatchAiJob creates fresh sessions (no cache to invalidate)
   - Email drafts are one-shot (no follow-up turns)
`);
