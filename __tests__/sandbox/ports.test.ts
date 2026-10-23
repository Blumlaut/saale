import { describe, expect, it } from "vitest";
import {
  describeProcessesCommand,
  isLoopbackAddress,
  mergePorts,
  parseFdListing,
  parseProcessDetails,
  parseProcNetTcp,
} from "@/sandbox/ports";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** A `/proc/net/tcp` line with the fields that matter filled in. */
function socketLine(local: string, state: string, inode: string): string {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

describe("parsing the listening sockets", () => {
  it("reads a wildcard bind, a loopback bind and drops what is not a listener", () => {
    const text = [
      HEADER,
      socketLine("00000000:1F90", "0A", "21011"), // 0.0.0.0:8080
      socketLine("0100007F:0BB8", "0A", "21012"), // 127.0.0.1:3000
      socketLine("00000000:0050", "01", "21013"), // established, not listening
    ].join("\n");

    expect(parseProcNetTcp(text)).toEqual([
      { port: 8080, address: "0.0.0.0", inode: "21011", loopback: false },
      { port: 3000, address: "127.0.0.1", inode: "21012", loopback: true },
    ]);
  });

  it("drops docker's embedded resolver, which listens in every container", () => {
    const text = [HEADER, socketLine("0B00007F:0035", "0A", "21014")].join("\n");
    expect(parseProcNetTcp(text)).toEqual([]);
  });

  it("reads the v6 table, including a mapped address and ::1", () => {
    const text = [
      HEADER,
      socketLine("00000000000000000000000000000000:1F91", "0A", "21015"), // [::]:8081
      socketLine("00000000000000000000000001000000:1F92", "0A", "21016"), // [::1]:8082
      socketLine("0000000000000000FFFF00000100007F:1F93", "0A", "21017"),
    ].join("\n");

    expect(parseProcNetTcp(text)).toEqual([
      { port: 8081, address: "0:0:0:0:0:0:0:0", inode: "21015", loopback: false },
      { port: 8082, address: "::1", inode: "21016", loopback: true },
      { port: 8083, address: "::ffff:127.0.0.1", inode: "21017", loopback: true },
    ]);
  });

  it("skips malformed and truncated lines without throwing", () => {
    const text = [
      HEADER,
      "garbage",
      "   0: zzzz nothex",
      "   0: 00000000:1F90 00000000:0000 0A",
      socketLine("00000000:1F94", "0A", "21018"),
    ].join("\n");

    expect(parseProcNetTcp(text)).toEqual([
      { port: 8084, address: "0.0.0.0", inode: "21018", loopback: false },
    ]);
  });

  it("knows a loopback address from a reachable one", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.0.2")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("172.18.0.4")).toBe(false);
  });
});

describe("finding the process behind a socket", () => {
  it("maps an inode to the pid that holds it", () => {
    const text = [
      "/proc/120/fd:",
      "total 0",
      "lrwx------ 1 root root 64 Oct 23 14:00 0 -> /dev/null",
      "lrwx------ 1 root root 64 Oct 23 14:00 3 -> socket:[21011]",
      "",
      "/proc/340/fd:",
      "total 0",
      "lrwx------ 1 root root 64 Oct 23 14:00 5 -> socket:[21012]",
      "lrwx------ 1 root root 64 Oct 23 14:00 6 -> socket:[21012]",
    ].join("\n");

    const owners = parseFdListing(text);
    expect(owners.get("21011")).toBe(120);
    expect(owners.get("21012")).toBe(340);
    expect(owners.size).toBe(2);
  });

  it("ignores entries before the first heading and files that are not sockets", () => {
    const text = [
      "lrwx------ 1 root root 64 Oct 23 14:00 3 -> socket:[99999]",
      "/proc/7/fd:",
      "total 0",
      "lrwx------ 1 root root 64 Oct 23 14:00 3 -> /workspaces/user-x/.tmp/a.log",
    ].join("\n");

    expect(parseFdListing(text).size).toBe(0);
  });

  it("prints one line per process and reads it back", () => {
    const command = describeProcessesCommand([12, 340]);
    expect(command).toContain("for p in 12 340");
    expect(describeProcessesCommand([])).toBe("true");

    const details = parseProcessDetails(
      [
        "12\t/workspaces/user-x/worktrees/saale/c-1\tnode  /app/node_modules/.bin/vite  --host 0.0.0.0 ",
        "340\t\tpython3 -m http.server 8080",
        "not-a-line",
      ].join("\n"),
    );

    expect(details.get(12)).toEqual({
      cwd: "/workspaces/user-x/worktrees/saale/c-1",
      command: "node /app/node_modules/.bin/vite --host 0.0.0.0",
    });
    // An unreadable cwd is reported as unknown rather than as the wrong directory.
    expect(details.get(340)).toEqual({ cwd: null, command: "python3 -m http.server 8080" });
  });
});

describe("merging what the three reads found", () => {
  it("keeps one entry per port and prefers the reachable bind", () => {
    const merged = mergePorts({
      sockets: [
        { port: 8080, address: "::", inode: "1", loopback: false },
        { port: 8080, address: "127.0.0.1", inode: "2", loopback: true },
        { port: 3000, address: "127.0.0.1", inode: "3", loopback: true },
      ],
      owners: new Map([
        ["1", 120],
        ["3", 340],
      ]),
      details: new Map([
        [120, { cwd: "/workspaces/user-x/worktrees/saale/c-1", command: "vite" }],
        [340, { cwd: "/workspaces/user-x/worktrees/saale/c-1", command: "flask run" }],
      ]),
    });

    expect(merged).toEqual([
      {
        port: 3000,
        address: "127.0.0.1",
        loopback: true,
        pid: 340,
        command: "flask run",
        cwd: "/workspaces/user-x/worktrees/saale/c-1",
      },
      {
        port: 8080,
        address: "::",
        loopback: false,
        pid: 120,
        command: "vite",
        cwd: "/workspaces/user-x/worktrees/saale/c-1",
      },
    ]);
  });

  it("reports a port whose owner it cannot find", () => {
    const merged = mergePorts({
      sockets: [{ port: 9000, address: "0.0.0.0", inode: "42", loopback: false }],
      owners: new Map(),
      details: new Map(),
    });

    expect(merged).toEqual([
      { port: 9000, address: "0.0.0.0", loopback: false, pid: null, command: null, cwd: null },
    ]);
  });
});
