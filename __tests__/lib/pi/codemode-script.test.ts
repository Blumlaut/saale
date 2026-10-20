import { describe, it, expect } from "vitest";
import { readScriptToolReferences } from "@/lib/pi/codemode-script";

/**
 * Reading a script is what the transcript card and the approval gate both do,
 * and they must see the same tools: the card tells the user what ran, the gate
 * decides what one approval covers. These cases pin the two ways a script names
 * a tool, and the two ways it hides one.
 */
describe("readScriptToolReferences", () => {
  it("finds the tools a script reaches, in first-use order, without duplicates", () => {
    const code = [
      "const a = await tools.infra_exec({ id: 'm1', command: 'ls' });",
      "const b = await tools.memory_search({ query: 'x' });",
      "const c = await tools.infra_exec({ id: 'm1', command: 'pwd' });",
      "return [a, b, c];",
    ].join("\n");

    expect(readScriptToolReferences(code).keys).toEqual(["infra_exec", "memory_search"]);
  });

  it("reads a name that is not a valid identifier through its bracket form", () => {
    expect(readScriptToolReferences('await tools["my-tool"]({})').keys).toEqual(["my-tool"]);
    expect(readScriptToolReferences("await tools['mcp__docs__search']({})").keys).toEqual([
      "mcp__docs__search",
    ]);
  });

  it("tolerates the whitespace JavaScript allows around the access", () => {
    expect(readScriptToolReferences("await tools . mail_list ()").keys).toEqual(["mail_list"]);
    expect(readScriptToolReferences('await tools [ "mail_list" ] ()').keys).toEqual(["mail_list"]);
  });

  it("counts a reference the script calls later through a variable", () => {
    // `const t = tools.mail_list` is a reference to the callable, so the call it
    // makes later is one the approval gate has to cover  reading only literal
    // `tools.x(` sites would miss it.
    const code = ["const send = tools.mail_send;", "await send({ to, subject });"].join("\n");
    expect(readScriptToolReferences(code).keys).toEqual(["mail_send"]);
  });

  it("reports a computed key as dynamic", () => {
    for (const code of [
      "const name = pick(); await tools[name]({});",
      "const t = ALL_TOOLS.find((t) => t.name === 'mail_send'); await tools[t.name]({});",
      "await tools[await searchTools('send email')[0].name]({});",
    ]) {
      expect(readScriptToolReferences(code).dynamic, code).toBe(true);
    }
  });

  it("keeps the keys it can read while reporting the dynamic ones", () => {
    const code = [
      "await tools.mail_tag({ ids, tag });",
      "const rest = ALL_TOOLS.filter((t) => t.description.includes('archive'));",
      "for (const t of rest) await tools[t.name]();",
    ].join("\n");

    expect(readScriptToolReferences(code)).toEqual({ keys: ["mail_tag"], dynamic: true });
  });

  it("does not report a script that reads no tools as dynamic", () => {
    expect(readScriptToolReferences("return 1 + 1;")).toEqual({ keys: [], dynamic: false });
    expect(readScriptToolReferences("")).toEqual({ keys: [], dynamic: false });
    // `tools` only appears as part of another identifier.
    expect(readScriptToolReferences("return toolshed.size;").keys).toEqual([]);
  });
});
