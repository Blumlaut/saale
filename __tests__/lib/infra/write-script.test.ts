import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWriteRequest } from "@/lib/infra/shell";

/**
 * The write request, run by a real shell.
 *
 * sshd hands these scripts to the login shell on stdin, so this is the exact
 * arrangement the remote machine sees, with the quotes, the heredoc and the
 * byte count all in play.
 */
describe("buildWriteRequest through /bin/sh", () => {
  let dir: string;

  beforeEach(() => {
    // A directory with the sorts of characters a path can hold.
    dir = mkdtempSync(path.join(tmpdir(), "saale write's "));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the script the way `sh -s` on the other end would. */
  function run(
    filePath: string,
    content: Buffer,
  ): { status: number; stdout: string; stderr: string } {
    const { stdin } = buildWriteRequest(filePath, content);

    try {
      const stdout = execFileSync("/bin/sh", ["-s"], { input: stdin, encoding: "utf8" });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }

  /** Whether the shell got as far as the marker the client waits for. */
  function finished(stdout: string): boolean {
    return stdout.includes("saale:done");
  }

  it("writes the exact bytes of a text file", () => {
    const target = path.join(dir, "ch-zrh-wg-001.peer");
    const content = Buffer.from(
      [
        "# Mullvad ch-zrh-wg-001 (Zürich) 193.32.127.71:51820",
        "PublicKey = chvFpRH+05o+ESv8QLzNyY3Phirsym0mUvF03Kt7oCo=",
        "AllowedIPs = 0.0.0.0/0",
        "Endpoint = 193.32.127.71:51820",
      ].join("\n"),
    );

    const result = run(target, content);

    expect(result.status).toBe(0);
    expect(finished(result.stdout)).toBe(true);
    expect(readFileSync(target).equals(content)).toBe(true);
  });

  it("writes a path with a quote and a space in it", () => {
    const target = path.join(dir, "it's a config.conf");

    expect(run(target, Buffer.from("key = value\n")).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("key = value\n");
  });

  it("keeps a missing trailing newline and a lone carriage return", () => {
    const target = path.join(dir, "crlf.conf");
    const content = Buffer.from("a\r\nb\rc\nd");

    expect(run(target, content).status).toBe(0);
    expect(readFileSync(target).equals(content)).toBe(true);
  });

  it("keeps bytes that are not text", () => {
    const target = path.join(dir, "logo.png");
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d, 0x00, 0x1a]);

    expect(run(target, content).status).toBe(0);
    expect(readFileSync(target).equals(content)).toBe(true);
  });

  it("writes a large body whole", () => {
    const target = path.join(dir, "big.log");
    const content = Buffer.alloc(1024 * 1024 + 7, "line of a log file\n");

    expect(run(target, content).status).toBe(0);
    expect(readFileSync(target).equals(content)).toBe(true);
  });

  it("writes an empty file", () => {
    const target = path.join(dir, "empty.conf");

    expect(run(target, Buffer.alloc(0)).status).toBe(0);
    expect(readFileSync(target).equals(Buffer.alloc(0))).toBe(true);
  });

  it("never runs what the content says", () => {
    const target = path.join(dir, "notes.txt");
    const canary = path.join(dir, "canary");
    const content = Buffer.from(
      `$(touch ${canary})\n\`touch ${canary}\`\n'; touch ${canary}; '\nSAALE_WRITE_EOF\n`,
    );

    expect(run(target, content).status).toBe(0);
    expect(readFileSync(target).equals(content)).toBe(true);
    expect(existsSync(canary)).toBe(false);
  });

  it("keeps the mode of the file it replaces", () => {
    const target = path.join(dir, "wg0.conf");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o600);

    expect(run(target, Buffer.from("new\n")).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("leaves the target untouched when the connection dropped mid-script", () => {
    const target = path.join(dir, "announce.conf");
    writeFileSync(target, "old and load bearing\n");

    // The script stopped arriving mid-heredoc, so the shell never reached the
    // check or the copy.
    const { stdin } = buildWriteRequest(target, Buffer.from("new configuration\n".repeat(200)));
    const lines = stdin.split("\n");
    const open = lines.findIndex((line) => line.startsWith("base64 -d > "));
    const truncated = lines.slice(0, open + 3).join("\n");

    const stdout = execFileSync("/bin/sh", ["-s"], { input: truncated, encoding: "utf8" });

    expect(finished(stdout)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("old and load bearing\n");
  });

  it("reports a decode failure instead of an empty file", () => {
    const target = path.join(dir, "broken.conf");
    writeFileSync(target, "old\n");

    const lines = buildWriteRequest(target, Buffer.from("new\n")).stdin.split("\n");
    const open = lines.findIndex((line) => line.startsWith("base64 -d > "));
    // Something that is not base64 at all.
    lines[open + 1] = "!!!! not base64 !!!!";

    expect(() => execFileSync("/bin/sh", ["-s"], { input: lines.join("\n") })).toThrow();

    expect(readFileSync(target, "utf8")).toBe("old\n");
  });

  it("leaves no temporary file behind", () => {
    const target = path.join(dir, "clean.conf");

    expect(run(target, Buffer.from("content\n")).status).toBe(0);

    expect(readdirSync(dir)).toEqual(["clean.conf"]);
  });

  it("leaves no temporary file behind when it fails", () => {
    const target = path.join(dir, "clean.conf");
    writeFileSync(target, "old\n");

    const lines = buildWriteRequest(target, Buffer.from("new\n")).stdin.split("\n");
    const open = lines.findIndex((line) => line.startsWith("base64 -d > "));
    lines[open + 1] = "!!!! not base64 !!!!";

    expect(() => execFileSync("/bin/sh", ["-s"], { input: lines.join("\n") })).toThrow();

    expect(readdirSync(dir)).toEqual(["clean.conf"]);
  });

  it("reports a target it cannot replace, without a marker", () => {
    // A directory in the target's place: the copy fails however much access
    // the account has.
    const target = path.join(dir, "a-directory");
    mkdirSync(target);

    const result = run(target, Buffer.from("x\n"));

    expect(result.status).not.toBe(0);
    expect(finished(result.stdout)).toBe(false);
    expect(result.stderr).not.toBe("");
  });

  it("creates a file that was not there", () => {
    const target = path.join(dir, "fresh.conf");

    expect(run(target, Buffer.from("hello\n")).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("hello\n");
    expect(readdirSync(dir)).toEqual(["fresh.conf"]);
  });

  it("writes through a symlink and leaves the link in place", () => {
    const real = path.join(dir, "real.conf");
    const link = path.join(dir, "current.conf");
    writeFileSync(real, "old\n");
    symlinkSync(real, link);

    expect(run(link, Buffer.from("new\n")).status).toBe(0);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new\n");
  });

  it("does not invent a missing parent directory", () => {
    const result = run(path.join(dir, "no-such-dir", "fresh.conf"), Buffer.from("hello\n"));

    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(dir, "no-such-dir"))).toBe(false);
  });
});
