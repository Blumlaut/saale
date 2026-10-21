import { describe, it, expect } from "vitest";
import {
  buildShellRequest,
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
