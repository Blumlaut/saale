import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A field written on the same line as a model/enum declaration is accepted by
 * `prisma validate` and then silently left out of the generated client.
 *
 * `model CouncilMessage {  id String @id @default(cuid())` lost the message's
 * `id` this way: every `prisma.councilMessage.create(...).id` became a type
 * error, and it only surfaced in a production build  the local client was
 * generated before the line was joined, so local typechecks passed.
 */
function fieldsOnDeclarationLine(schema: string): string[] {
  return schema
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        /^(model|enum|type|view)\s+[A-Za-z0-9_]+\s*\{/.test(line) && !/\{\s*(\/\/.*)?$/.test(line),
    );
}

const SCHEMA_PATH = path.join(process.cwd(), "prisma", "schema.prisma");

describe("prisma schema shape", () => {
  it("detects a field sharing a declaration line", () => {
    const broken = [
      "model CouncilMessage {  id        String  @id @default(cuid())",
      "  councilId String",
      "}",
      "model Council {",
      "  id String @id",
      "}",
      "enum CouncilStatus { // trailing comment is fine",
      "  idle",
      "}",
    ].join("\n");

    expect(fieldsOnDeclarationLine(broken)).toEqual([
      "model CouncilMessage {  id        String  @id @default(cuid())",
    ]);
  });

  it("declares every model and enum across two lines", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    expect(fieldsOnDeclarationLine(schema)).toEqual([]);
  });

  it("gives every council row a primary key the app can read back", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const blocks = schema.matchAll(/^model (Council\w*) \{([\s\S]*?)^\}/gm);
    const models = [...blocks];

    expect(models.map(([, name]) => name)).toEqual([
      "Council",
      "CouncilMember",
      "CouncilRun",
      "CouncilMessage",
      "CouncilMemberTurn",
    ]);
    for (const [, name, body] of models) {
      // Either a field-level key or a compound one, but never neither: without a
      // key Prisma refuses the schema outright, and without the key *field* the
      // generated client omits it.
      expect(body, `${name} needs a primary key`).toMatch(/@id|@@id\(/);
      if (!/@@id\(/.test(body!)) {
        const keyed = body!.split("\n").filter((line) => line.includes("@id"));
        expect(keyed, `${name}'s key field must be on its own line`).toHaveLength(1);
      }
    }
  });
});
