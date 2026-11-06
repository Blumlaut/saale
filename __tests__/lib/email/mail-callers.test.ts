/**
 * Everything the instance mails a person goes through the relay and wears the
 * same frame, so a new send belongs in `instance-mail-messages.ts` rather than
 * reaching for the transport with markup of its own.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function sourceFiles(dir = "src"): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Where each file that names `needle` lives. */
function filesMentioning(needle: string): string[] {
  return sourceFiles()
    .filter((file) => readFileSync(join(ROOT, file), "utf8").includes(needle))
    .sort();
}

describe("the instance's mail", () => {
  it("is sent from the two mail modules and nowhere else", () => {
    expect(filesMentioning("sendInstanceMail(")).toEqual([
      "src/lib/email/instance-mail-messages.ts",
      "src/lib/email/instance-mail.ts",
    ]);
  });

  it("builds its markup in the one template", () => {
    // The sandbox preview renders a page of its own, which is not mail.
    expect(filesMentioning("<!doctype html>")).toEqual([
      "src/lib/email/mail-template.ts",
      "src/sandbox/preview-proxy.ts",
    ]);
  });
});
