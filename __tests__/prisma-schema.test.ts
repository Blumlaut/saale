import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A field written on the same line as a model/enum declaration is accepted by
 * `prisma validate` and then silently left out of the generated client.
 *
 * A key field written that way once cost a column: the create returned no `id`,
 * and it only surfaced in a production build, because the local client was
 * generated before the line was joined.
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
      "model Watcher {  id        String  @id @default(cuid())",
      "  userId String",
      "}",
      "model User {",
      "  id String @id",
      "}",
      "enum Theme { // trailing comment is fine",
      "  dark",
      "}",
    ].join("\n");

    expect(fieldsOnDeclarationLine(broken)).toEqual([
      "model Watcher {  id        String  @id @default(cuid())",
    ]);
  });

  it("declares every model and enum across two lines", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    expect(fieldsOnDeclarationLine(schema)).toEqual([]);
  });

  it("gives every row a primary key the app can read back", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];

    expect(models.length).toBeGreaterThan(0);
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
