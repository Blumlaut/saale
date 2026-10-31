import { describe, it, expect } from "vitest";
import {
  buildShellRequest,
  buildMkdirRequest,
  buildWriteRequest,
  parsePlatformProbe,
  InvalidExecOptionsError,
  PLATFORM_PROBE,
} from "@/lib/infra/shell";

const POSIX_REQUEST = 'exec "${SHELL:-/bin/sh}" -s';
const WINDOWS_REQUEST = "cmd.exe /D /Q";

describe("buildShellRequest on POSIX", () => {
  it("sends the bare command as the script", () => {
    const { request, stdin } = buildShellRequest("posix", "systemctl restart nginx");

    expect(request).toBe(POSIX_REQUEST);
    expect(stdin).toBe("systemctl restart nginx");
  });

  it("keeps the command out of the exec request", () => {
    const { request } = buildShellRequest("posix", "pkill -f health_scan.py");

    expect(request).not.toContain("pkill");
    expect(request).not.toContain("health_scan.py");
  });

  it("exports each variable before the command, quoting values", () => {
    const { stdin } = buildShellRequest("posix", "node index.js", {
      env: { NODE_ENV: "production", GREETING: "hi there", NAME: "o'brien" },
    });

    expect(stdin).toBe(
      "export NODE_ENV='production'\n" +
        "export GREETING='hi there'\n" +
        "export NAME='o'\\''brien'\n" +
        "node index.js",
    );
  });

  it("changes directory before running the command and fails loudly if it cannot", () => {
    const { stdin } = buildShellRequest("posix", "tar czf backup.tar.gz /srv", {
      cwd: "/srv/app",
    });

    expect(stdin).toBe("cd '/srv/app' || exit 1\ntar czf backup.tar.gz /srv");
  });

  it("quotes a working directory that contains spaces and quotes", () => {
    const { stdin } = buildShellRequest("posix", "ls", { cwd: "/opt/my app's dir" });

    expect(stdin).toBe("cd '/opt/my app'\\''s dir' || exit 1\nls");
  });

  it("leaves a multi-line command intact", () => {
    const command = "set -e\ncd /tmp\n./deploy.sh";
    const { stdin } = buildShellRequest("posix", command);

    expect(stdin).toBe(command);
  });
});

describe("buildMkdirRequest", () => {
  it("creates the path over the login shell, quoted", () => {
    const { request, stdin } = buildMkdirRequest("/srv/my app's dir");

    expect(request).toBe(POSIX_REQUEST);
    expect(stdin).toBe("mkdir -p '/srv/my app'\\''s dir' && echo saale:done");
  });
});

describe("buildWriteRequest", () => {
  /** The bytes the heredoc carries, as the remote base64 would decode them. */
  function heredocBytes(stdin: string): Buffer {
    const lines = stdin.split("\n");
    const open = lines.findIndex((line) => line.startsWith("base64 -d > "));
    const close = lines.indexOf("SAALE_WRITE_EOF", open + 1);
    return Buffer.from(lines.slice(open + 1, close).join(""), "base64");
  }

  it("decodes into a file beside the target, then copies it over", () => {
    const { request, stdin } = buildWriteRequest(
      "/etc/wireguard/ch-zrh.peer",
      Buffer.from("Endpoint = 1.2.3.4\n"),
    );

    expect(request).toBe(POSIX_REQUEST);
    expect(request).not.toContain("Endpoint");
    expect(stdin.split("\n").slice(0, 3)).toEqual([
      "temp='/etc/wireguard/ch-zrh.peer'.saale-$$",
      "trap 'rm -f \"$temp\"' EXIT",
      "base64 -d > \"$temp\" <<'SAALE_WRITE_EOF'",
    ]);
    expect(stdin.split("\n").slice(-3)).toEqual([
      "size=$(wc -c < \"$temp\" | tr -d ' ')",
      '[ "$size" = \'19\' ] || { echo "wrote $size of 19 bytes to $temp" >&2; exit 1; }',
      "cat \"$temp\" > '/etc/wireguard/ch-zrh.peer' && echo saale:done",
    ]);
    expect(heredocBytes(stdin).toString("utf8")).toBe("Endpoint = 1.2.3.4\n");
  });

  it("checks the byte count before it touches the target", () => {
    const { stdin } = buildWriteRequest("/tmp/a", Buffer.from("four"));

    const check = stdin.indexOf("[ \"$size\" = '4' ]");
    const copy = stdin.indexOf("cat \"$temp\" > '/tmp/a'");
    expect(check).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(check);
  });

  it("decodes back to the same bytes, whatever the content says", () => {
    const content = "SAALE_WRITE_EOF\n'; rm -rf / #\n$(whoami) `id`\n\t\n";

    const { stdin } = buildWriteRequest("/tmp/notes.txt", Buffer.from(content));

    expect(heredocBytes(stdin).toString("utf8")).toBe(content);
    // The content cannot end the heredoc, so the delimiter stands once.
    expect(stdin.split("\n").filter((line) => line === "SAALE_WRITE_EOF")).toHaveLength(1);
  });

  it("keeps bytes that are not text", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d]);

    const { stdin } = buildWriteRequest("/tmp/logo.png", bytes);

    expect(heredocBytes(stdin).equals(bytes)).toBe(true);
  });

  it("wraps a long body so no heredoc line runs away", () => {
    const content = "x".repeat(500);

    const { stdin } = buildWriteRequest("/tmp/big.txt", Buffer.from(content));

    const lines = stdin.split("\n");
    const body = lines.slice(
      lines.findIndex((line) => line.startsWith("base64 -d > ")) + 1,
      lines.indexOf("SAALE_WRITE_EOF"),
    );
    expect(body.length).toBeGreaterThan(1);
    expect(body.every((line) => line.length <= 76)).toBe(true);
    expect(heredocBytes(stdin).toString("utf8")).toBe(content);
  });

  it("declares an empty write as zero bytes", () => {
    const { stdin } = buildWriteRequest("/tmp/empty", Buffer.alloc(0));

    expect(heredocBytes(stdin)).toHaveLength(0);
    expect(stdin).toContain("[ \"$size\" = '0' ]");
  });
});

describe("buildShellRequest on Windows", () => {
  it("runs cmd.exe and keeps the command on stdin", () => {
    const { request, stdin } = buildShellRequest("windows", "dir C:\\inetpub");

    expect(request).toBe(WINDOWS_REQUEST);
    expect(request).not.toContain("inetpub");
    expect(stdin.split("\r\n")).toEqual(["dir C:\\inetpub", "exit %ERRORLEVEL%"]);
  });

  it("separates script lines the way cmd.exe expects", () => {
    const { stdin } = buildShellRequest("windows", "node index.js", { env: { PORT: "3000" } });

    expect(stdin.split("\r\n")).toEqual(['set "PORT=3000"', "node index.js", "exit %ERRORLEVEL%"]);
  });

  it("changes directory with /d and stops when the path does not exist", () => {
    const { stdin } = buildShellRequest("windows", "node server.js", {
      cwd: "C:\\inetpub\\amy",
    });

    expect(stdin.split("\r\n")).toEqual([
      'cd /d "C:\\inetpub\\amy"',
      "if errorlevel 1 exit 1",
      "node server.js",
      "exit %ERRORLEVEL%",
    ]);
  });

  it("places the working directory ahead of the environment when both are set", () => {
    const { stdin } = buildShellRequest("windows", "npm test", {
      cwd: "C:\\app",
      env: { CI: "1" },
    });

    expect(stdin.split("\r\n")).toEqual([
      'set "CI=1"',
      'cd /d "C:\\app"',
      "if errorlevel 1 exit 1",
      "npm test",
      "exit %ERRORLEVEL%",
    ]);
  });

  it("rejects an environment value cmd cannot carry", () => {
    expect(() => buildShellRequest("windows", "echo hi", { env: { CONFIG: '{"a":1}' } })).toThrow(
      InvalidExecOptionsError,
    );
  });

  it("rejects a working directory cmd cannot carry", () => {
    expect(() => buildShellRequest("windows", "echo hi", { cwd: 'C:\\a"b' })).toThrow(
      /Cannot pass the working directory to a Windows machine/,
    );
  });
});

describe("buildShellRequest environment names", () => {
  it("rejects a name the shell cannot assign, on either platform", () => {
    for (const platform of ["posix", "windows"] as const) {
      expect(() => buildShellRequest(platform, "echo hi", { env: { "not a name": "1" } })).toThrow(
        "Invalid environment variable name: not a name",
      );
    }
  });

  it("accepts names with digits and underscores past the first character", () => {
    const { stdin } = buildShellRequest("posix", "echo hi", { env: { _A1: "1" } });

    expect(stdin).toBe("export _A1='1'\necho hi");
  });
});

describe("parsePlatformProbe", () => {
  it("recognises cmd.exe answering with the OS name", () => {
    expect(parsePlatformProbe("Windows_NT\r\n", 0)).toBe("windows");
    expect(parsePlatformProbe("  windows_nt  ", 0)).toBe("windows");
  });

  it("recognises cmd.exe echoing an unset %OS%", () => {
    expect(parsePlatformProbe("%OS%\r\n", 0)).toBe("windows");
  });

  it("accepts an answer from a server that reports no exit status", () => {
    expect(parsePlatformProbe("Windows_NT\r\n", null)).toBe("windows");
  });

  it("reads a missing cmd.exe as POSIX", () => {
    expect(parsePlatformProbe("", 127)).toBe("posix");
    expect(parsePlatformProbe("sh: 1: cmd.exe: not found\n", 127)).toBe("posix");
    expect(parsePlatformProbe("Linux", 1)).toBe("posix");
  });

  it("reads an unexpected answer as POSIX", () => {
    expect(parsePlatformProbe("some other thing", 0)).toBe("posix");
    expect(parsePlatformProbe("", 0)).toBe("posix");
  });

  it("asks for the platform without naming a user command", () => {
    expect(PLATFORM_PROBE).toContain("cmd.exe");
    expect(PLATFORM_PROBE).toContain("%OS%");
  });
});
