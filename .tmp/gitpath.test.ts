import { execFile } from "node:child_process";
import { it } from "vitest";
it("path", () => {
  console.log("PATH=", process.env.PATH);
  execFile("git", ["--version"], (e, o) => console.log("err", e?.message, "out", o));
});
