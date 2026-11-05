/**
 * What a shell command does, for the two questions the approval gate asks.
 *
 * `classifyCommand` answers "does this change anything": the infra_exec and bash
 * "auto" policy runs a read and asks about a mutation.
 *
 * `escapesWorkspace` answers "can this reach past the workspace": a coder chat's
 * policy, where editing files is the job and only leaving the workspace asks.
 *
 * Both are heuristics over the command text. They read every command in a chain
 * or a pipeline rather than its first word, and when in doubt they err towards
 * asking.
 */

import { resolveWithinRoot } from "@/lib/files/paths";

// ─── Shell parsing ──────────────────────────────────────────────────────────

/**
 * The command with every quoted span blanked out, so the content of a quote is
 * read as data: `grep ">" file` searches, it writes nothing.
 */
function stripQuoted(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote) {
      // Inside double quotes a backslash escapes the next character.
      if (char === "\\" && quote === '"') {
        out += "  ";
        i++;
        continue;
      }
      if (char === quote) quote = null;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/** One command per entry, so a `&&` chain and a pipeline are read in full. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);

    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += command.charAt(i + 1);
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }

    if (
      char === ";" ||
      char === "|" ||
      char === "\n" ||
      // A lone `&` separates commands in cmd.exe too, but not in `2>&1`.
      (char === "&" && !"<>".includes(command.charAt(i - 1)))
    ) {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }
  segments.push(current);

  return segments
    .map((segment) => segment.trim().replace(/^&+/, "").trim())
    .filter((segment) => segment !== "");
}

/** The words of one segment, quotes stripped. */
function wordsOf(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter((word) => word !== "");
}

/**
 * Commands that hand their arguments to another program, so the word after them
 * is the command being judged: `timeout 30 rm -rf /` removes a directory.
 *
 * A shell (`bash -c '…'`) stays out: its script is not parsed here, so it asks.
 */
const WRAPPERS = new Set(["timeout", "nice", "ionice", "nohup", "env", "exec", "command", "xargs"]);

/** A wrapper's own argument: a flag, a duration (`30`, `5s`), or an assignment. */
const WRAPPER_ARGUMENT = /^-|^\d+(\.\d+)?[smh]?$/;

/** An assignment ahead of the command: `HOME=/root cat x`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program one segment runs, and the words after it. */
interface ParsedCommand {
  command: string;
  /** Words after the command, subcommand first. */
  args: string[];
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

function parseCommand(segment: string): ParsedCommand | null {
  const words = wordsOf(segment);
  let index = 0;

  while (index < words.length && ASSIGNMENT.test(words[index] ?? "")) index++;

  let wrapper: string | null = null;
  while (index < words.length && WRAPPERS.has(words[index] ?? "")) {
    wrapper = words[index] ?? null;
    index++;
    while (index < words.length) {
      const next = words[index] ?? "";
      if (!WRAPPER_ARGUMENT.test(next) && !ASSIGNMENT.test(next)) break;
      index++;
    }
  }

  const word = words[index];
  if (word === undefined) {
    // A wrapper with nothing after it is the command itself (`env`, `xargs`).
    return wrapper === null ? null : { command: basename(wrapper), args: [] };
  }

  return { command: basename(word), args: words.slice(index + 1) };
}

// ─── Safe commands (read-only or navigation) ────────────────────────────────

/** Commands that are always safe (no flags can make them dangerous). */
const ALWAYS_SAFE = new Set([
  // Navigation
  "cd",
  "pwd",

  // Listing
  "ls",
  "dir",
  "vdir",
  "tree",

  // Reading file contents
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "column",
  "zcat",
  "zgrep",

  // Text processing (read-only)
  "grep",
  "egrep",
  "fgrep",
  "awk",
  "uniq",
  "cut",
  "tr",
  "comm",
  "diff",
  "cmp",
  "wc",
  "fold",
  "join",
  "paste",
  "split",
  "csplit",
  "expand",
  "unexpand",
  "printf",
  "echo",
  "jq",
  "strings",
  "xxd",
  "od",
  "hexdump",
  "base64",
  "sha256sum",
  "sha1sum",
  "sha512sum",
  "md5sum",

  // File/directory info (read-only)
  "file",
  "stat",
  "identify",
  "lsblk",
  "blkid",

  // System info
  "uname",
  "uptime",
  "date",
  "whoami",
  "id",
  "groups",
  "hostname",
  "domainname",
  "dmesg",
  "lscpu",
  "lsmod",
  "nproc",
  "arch",
  "tty",
  "w",
  "last",
  "getent",
  "systemd-analyze",

  // Disk/memory info
  "df",
  "du",
  "free",
  "vmstat",
  "iostat",
  "mpstat",
  "pidstat",
  "sensors",

  // Volumes and Proxmox report their state through one command
  "lvs",
  "pvs",
  "vgs",
  "lvmdiskscan",
  "lvdisplay",
  "vgdisplay",
  "pvdisplay",
  "lvscan",
  "vgscan",
  "pvscan",
  "pveversion",

  // Process/network info
  "ps",
  "pgrep",
  "pidof",
  "top",
  "htop",
  "lsof",
  "netstat",
  "ss",
  "ip",
  "ifconfig",
  "route",
  "traceroute",
  "ping",
  "dig",
  "nslookup",
  "host",

  // Logs
  "journalctl",

  // Lookup
  "which",
  "whereis",
  "type",
  "command",
  "apropos",
  "man",
  "info",
  "whatis",

  // Archive inspection (read-only)
  "zipinfo",
  "unzip",

  // Search
  "locate",

  // Misc safe
  "true",
  "false",
  "test",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "seq",
  "sleep",
  "mktemp",
  "bc",
  "expr",
  "env",
  "printenv",
  "set",
  "shopt",
  "alias",
  "unalias",
  "hash",
  "help",
  "history",
]);

// ─── Reporting subcommands ──────────────────────────────────────────────────

/**
 * A tool whose subcommand decides whether the call reports or changes
 * something: `systemctl status` reads, `systemctl restart` does not.
 */
interface SubcommandRule {
  /** First words that only report. A flag counts: `crontab -l`. */
  report: ReadonlySet<string>;
  /** A group word, where the word after it decides: `docker compose ps`. */
  groups?: ReadonlySet<string>;
  /** A flag that makes even a reporting form change something. */
  mutating?: RegExp;
}

/**
 * The first words of the dual-use tools worth knowing by name. Anything else
 * these tools are called with is treated as a mutation, which is what most of
 * them are.
 */
const SUBCOMMAND_RULES: Record<string, SubcommandRule> = {
  systemctl: {
    report: new Set([
      "status",
      "is-active",
      "is-enabled",
      "is-failed",
      "show",
      "cat",
      "help",
      "get-default",
      "list-units",
      "list-unit-files",
      "list-timers",
      "list-sockets",
      "list-jobs",
      "list-machines",
      "list-dependencies",
      "--version",
      "--failed",
      "--state",
    ]),
  },
  service: {
    report: new Set(),
  },
  git: {
    report: new Set([
      "status",
      "log",
      "diff",
      "show",
      "blame",
      "shortlog",
      "reflog",
      "grep",
      "fetch",
      "ls-files",
      "ls-tree",
      "ls-remote",
      "rev-parse",
      "rev-list",
      "describe",
      "cat-file",
      "count-objects",
      "merge-base",
      "whatchanged",
    ]),
  },
  docker: {
    report: new Set([
      "ps",
      "logs",
      "inspect",
      "images",
      "info",
      "version",
      "stats",
      "events",
      "top",
      "port",
      "diff",
      "search",
      "history",
      "ls",
      "df",
      "help",
    ]),
    groups: new Set([
      "compose",
      "container",
      "image",
      "network",
      "volume",
      "node",
      "service",
      "secret",
      "config",
      "plugin",
      "context",
      "system",
      "builder",
      "swarm",
    ]),
  },
  "docker-compose": {
    report: new Set(["ps", "logs", "config", "version", "top", "images", "ls", "port", "events"]),
  },
  kubectl: {
    report: new Set([
      "get",
      "describe",
      "logs",
      "top",
      "version",
      "explain",
      "api-resources",
      "api-versions",
      "cluster-info",
      "diff",
      "events",
    ]),
    groups: new Set(["config", "auth"]),
  },
  crontab: { report: new Set(["-l", "--list"]) },
  ufw: { report: new Set(["status"]) },
  zfs: { report: new Set(["list", "get", "holds", "userspace", "groupspace"]) },
  zpool: {
    report: new Set(["status", "list", "iostat", "get", "history", "events", "version"]),
  },
  pvesm: { report: new Set(["status", "list"]) },
  pvecm: { report: new Set(["status", "nodes"]) },
  qm: { report: new Set(["list", "status", "config", "pending"]) },
  pct: { report: new Set(["list", "status", "config", "pending"]) },
  dpkg: {
    report: new Set([
      "-l",
      "-L",
      "-s",
      "-S",
      "-p",
      "--list",
      "--listfiles",
      "--status",
      "--search",
      "--print-avail",
      "--get-selections",
    ]),
  },
  apt: {
    report: new Set(["list", "search", "show", "policy", "depends", "rdepends", "changelog"]),
  },
  npm: {
    report: new Set([
      "ls",
      "list",
      "view",
      "info",
      "outdated",
      "why",
      "root",
      "prefix",
      "audit",
      "search",
      "help",
      "explain",
    ]),
  },
  pnpm: {
    report: new Set([
      "ls",
      "list",
      "view",
      "info",
      "outdated",
      "why",
      "root",
      "audit",
      "search",
      "help",
      "explain",
    ]),
  },
  yarn: {
    report: new Set(["list", "info", "why", "outdated", "audit", "cache"]),
  },
  bun: {
    report: new Set(["pm", "info"]),
  },
};

/** Whether a rule's subcommand only reports. */
function reportsOnly(rule: SubcommandRule, args: string[]): boolean {
  // `service nginx status` puts the service before the verb.
  if (rule.report.size === 0) return args[1] === "status" || args[1] === "reload-status";

  const first = args[0];
  if (first === undefined) return false;
  if (rule.report.has(first)) return true;

  const second = args[1];
  return second !== undefined && (rule.groups?.has(first) ?? false) && rule.report.has(second);
}

// ─── Conditionally safe commands ────────────────────────────────────────────

/**
 * Commands that are safe only without dangerous flags.
 * Maps command → set of risky flag patterns (matched against the full command string).
 */
const CONDITIONAL_SAFE: Record<string, RegExp[]> = {
  sed: [/-i(\s|$)/, /-\s*i(\s|$)/, /--in-place\b/],
  sort: [/\s-o\s*\S/, /--output[=\s]/],
  find: [
    /-delete\b/,
    /-exec\b/,
    /-execdir\b/,
    /-ok\b/,
    /-okdir\b/,
    /-fls\b/,
    /-fprint\b/,
    /-fprint0\b/,
  ],
  // For tar, check both standalone flags and bundled short flags (e.g., -cf)
  // Only match single-dash short flags (not --long options)
  tar: [
    /\s-[a-zA-Z]*c[a-zA-Z]*/,
    /--create\b/,
    /\s-[a-zA-Z]*x[a-zA-Z]*/,
    /--extract\b/,
    /--delete\b/,
    /\s-[a-zA-Z]*u[a-zA-Z]*/,
    /--update\b/,
    /\s-[a-zA-Z]*r[a-zA-Z]*/,
    /--append\b/,
    /\s-[a-zA-Z]*w[a-zA-Z]*/,
    /--verify\b/,
  ],
};

// ─── Risky commands ─────────────────────────────────────────────────────────

/**
 * Commands that always change state: destructive, privileged, or running code
 * of their own. A tool with a subcommand rule is left out, since there the
 * subcommand decides.
 */
const ALWAYS_RISKY = new Set([
  // Destructive
  "rm",
  "rmdir",
  "unlink",

  // File mutation
  "mv",
  "cp",
  "install",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "ln",
  "tee",

  // Package management
  "apt-get",
  "aptitude",
  "yum",
  "dnf",
  "pacman",
  "pip",
  "pip3",
  "cargo",
  "go",
  "gem",
  "composer",

  // Service management
  "reload",

  // Network mutation
  "curl",
  "wget",
  "scp",
  "sftp",
  "rsync",

  // Privilege escalation
  "sudo",
  "su",

  // Shell execution
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "eval",

  // Database
  "mysql",
  "psql",
  "mongo",
  "sqlite3",
  "redis-cli",

  // Build/compile
  "make",
  "cmake",
  "gcc",
  "g++",
  "clang",
  "javac",
  "python",
  "python3",
  "node",
  "java",
  "ruby",
  "php",
  "perl",
  "rustc",

  // Compression (creates files)
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "xzdec",
  "zip",

  // Disk/partition
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "mount",
  "umount",
  "format",

  // User management
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",

  // Firewall
  "iptables",
  "ufw",
  "firewall-cmd",

  // Kill/stop processes
  "kill",
  "killall",
  "pkill",

  // Reboot/shutdown
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
]);

/**
 * Patterns over the whole command that change state whatever the command word
 * is. A here-document can write a file through a command that only reads.
 */
const RISKY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /<<(?!<)-?\s*['"]?\w+['"]?/, reason: "here-document" },
];

/** Operators that write a file: `>`, `>>`, `>|`, `&>`, `&>>`. */
const WRITE_REDIRECT = /(\d*)(&>>|&>|>>|>\|?)\s*([^\s;|<>]*)/g;

/** Targets that take the output without changing a file: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECT = /^&\d+$|^&-$|^\/dev\/(null|stdout|stderr|tty)$/;

/** The first write redirect in the command, if it has one. */
function findWriteRedirect(command: string): string | null {
  for (const match of stripQuoted(command).matchAll(WRITE_REDIRECT)) {
    const target = match[3] ?? "";
    // A target that was quoted is blanked out here, so an empty one is unknown.
    if (target === "") return "write redirect";
    if (HARMLESS_REDIRECT.test(target)) continue;
    return `write redirect (${match[2] ?? ">"} ${target})`;
  }
  return null;
}

/**
 * A script's `$(…)` and backtick bodies, classified as their own command.
 * Reads run, a substitution that changes state asks.
 */
function classifySubstitutions(
  command: string,
  depth: number,
): { safety: "risky"; reason: string } | null {
  for (const match of stripQuoted(command).matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const body = (match[1] ?? match[2] ?? "").trim();
    // `$((1 + 2))` is arithmetic, so there is no command to read.
    if (body === "" || body.startsWith("(")) continue;
    const verdict = classify(body, depth + 1);
    if (verdict.safety === "risky") {
      return { safety: "risky", reason: "command substitution changes state" };
    }
  }
  return null;
}

// ─── Workspace scope ────────────────────────────────────────────────────────

/** Where a command runs, and how far it may reach. */
export interface WorkspaceScope {
  /** Absolute root the command may work in: the user's whole workspace. */
  root: string;
  /** Directory it runs in, which is what relative paths resolve against. */
  cwd: string;
}

/**
 * Commands that reach past the workspace by name: the network, another host,
 * or the container and the machine it runs on.
 */
const LEAVES_WORKSPACE = new Set([
  // Network and remote hosts
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
  "gh",
  "docker",
  "podman",
  "kubectl",
  "aws",
  "gcloud",
  "az",
  "heroku",
  "vercel",
  "netlify",
  "flyctl",
  "wrangler",

  // The container and the host it runs on
  "sudo",
  "su",
  "chroot",
  "nsenter",
  "mount",
  "umount",
  "systemctl",
  "service",
  "crontab",
  "iptables",
  "ufw",
  "firewall-cmd",
  "kill",
  "killall",
  "pkill",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "mkfs",
  "fdisk",
  "parted",
  "dd",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
]);

/**
 * Commands that leave the workspace through one of their subcommands and are
 * otherwise the whole point of a coding chat (`git`, `npm`).
 */
const LEAVES_WORKSPACE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(["push", "send-email"]),
  npm: new Set(["publish"]),
  yarn: new Set(["publish"]),
  pnpm: new Set(["publish"]),
  bun: new Set(["publish"]),
  cargo: new Set(["publish"]),
  gem: new Set(["push"]),
  twine: new Set(["upload"]),
};

/**
 * Whether a command can reach past the workspace.
 *
 * This is the question a coder chat's gate asks, where the safety classifier's
 * does not apply: a coder chat exists to change files, so a mutation inside the
 * workspace runs. What still asks is a command that leaves it, one that talks to
 * the network, drives the container or the host, or names a path the workspace
 * does not hold.
 *
 * It reads the command text, so a program that reaches the network on its own
 * (`node -e`, `python -c`) stays out of its sight.
 */
export function escapesWorkspace(command: string, scope: WorkspaceScope): boolean {
  for (const segment of shellSegments(command)) {
    for (const name of commandWords(segment)) {
      if (LEAVES_WORKSPACE.has(name)) return true;

      const leaving = LEAVES_WORKSPACE_SUBCOMMANDS[name];
      if (!leaving) continue;
      const words = wordsOf(segment);
      // The first word after the command that is not a flag is its subcommand.
      const subcommand = words.slice(words.indexOf(name) + 1).find((word) => !word.startsWith("-"));
      if (subcommand && leaving.has(subcommand)) return true;
    }
  }

  return pathArguments(command).some((token) => !isInsideWorkspace(token, scope));
}

/**
 * Commands that hand their arguments to another command, so the word after them
 * is a command too: `ls | xargs gh pr list` reaches the network.
 */
const WORKSPACE_WRAPPERS = new Set([
  "xargs",
  "watch",
  "exec",
  "command",
  "eval",
  "nohup",
  "env",
  "timeout",
  "nice",
  "bash",
  "sh",
  "zsh",
  "fish",
]);

/** A wrapper's own argument: a flag, a duration (`30`, `5s`), or an assignment. */
const WORKSPACE_WRAPPER_ARGUMENT = /^-|^\d+(\.\d+)?[smh]?$/;

/**
 * The words of a segment that name the program being run: its first word, and
 * the word after any wrapper.
 *
 * A word inside quotes is taken as data. `git commit -m "fix the docker build"`
 * names a command in a message, not at a terminal.
 */
function commandWords(segment: string): string[] {
  const words: string[] = [];
  const parts = segment.match(/"[^"]*"|'[^']*'|[^\s"'`]+/g) ?? [];
  let expectCommand = true;
  for (const part of parts) {
    const quoted = part.startsWith('"') || part.startsWith("'");
    const word = part.replace(/^["']|["']$/g, "");
    if (quoted) {
      expectCommand = false;
      continue;
    }

    const isArgument = WORKSPACE_WRAPPER_ARGUMENT.test(word) || word.includes("=");
    if (expectCommand && !isArgument) words.push(word);
    // A wrapper is still waiting for its own command.
    expectCommand = WORKSPACE_WRAPPERS.has(word) || (expectCommand && isArgument);
  }
  return words;
}

/**
 * Every argument that could name a path: separators split it out of the
 * command, and a `--flag=value` keeps only the value.
 */
function pathArguments(command: string): string[] {
  const values: string[] = [];
  for (const raw of command.split(/[\s;&|()<>`]+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (!token) continue;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (value) values.push(value);
  }
  return values;
}

/**
 * Outside the workspace and harmless: the devices a command sends its output to
 * (`>/dev/null`, `2>&1`), which every build script uses to quieten itself.
 */
const HARMLESS_PATHS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);
const HARMLESS_PATH_PREFIXES = ["/dev/fd/", "/proc/self/fd/"];

/**
 * Whether one argument stays inside the workspace.
 *
 * `~` and `$HOME` are the workspace root: the sandbox container mounts the
 * workspace at `$HOME`, and a command run on a development host is given the
 * identity's directory as `HOME` too.
 */
function isInsideWorkspace(token: string, scope: WorkspaceScope): boolean {
  // A NUL byte can truncate a path inside a syscall, so it never counts as safe.
  if (token.includes("\0")) return false;
  if (token === "~" || token.startsWith("~/")) return true;
  if (token.startsWith("$HOME") || token.startsWith("${HOME}")) return true;
  if (HARMLESS_PATHS.has(token)) return true;
  if (HARMLESS_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return true;
  if (!token.startsWith("/") && !token.includes("..")) return true;
  const absolute = token.startsWith("/") ? token : `${scope.cwd}/${token}`;
  return resolveWithinRoot(scope.root, absolute).inside;
}

// ─── Classification ─────────────────────────────────────────────────────────

export type CommandSafety = "safe" | "risky";
export type CommandClassification = {
  safety: CommandSafety;
  reason: string;
};

/** How deep a `$(…)` inside a `$(…)` is still read. */
const MAX_SUBSTITUTION_DEPTH = 3;

/**
 * Classify a shell command as safe or risky.
 *
 * Safe: read-only operations (ls, cat, grep, system info, etc.)
 * Risky: anything that modifies state, deletes data, escalates privileges, etc.
 *
 * Every command in a chain or a pipeline has to be safe: `ls && rm -rf /` asks.
 * When in doubt, classifies as "risky".
 */
export function classifyCommand(command: string): CommandClassification {
  return classify(command, 0);
}

function classify(command: string, depth: number): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return { safety: "safe", reason: "empty command" };
  }
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    return { safety: "risky", reason: "deeply nested command substitution" };
  }

  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safety: "risky", reason };
    }
  }

  const substitution = classifySubstitutions(trimmed, depth);
  if (substitution) return substitution;

  const redirect = findWriteRedirect(trimmed);
  if (redirect) {
    return { safety: "risky", reason: redirect };
  }

  const segments = shellSegments(trimmed);
  if (segments.length === 0) {
    return { safety: "risky", reason: "could not parse command" };
  }

  for (const segment of segments) {
    const verdict = classifySegment(segment);
    if (verdict.safety === "risky") return verdict;
  }

  return { safety: "safe", reason: "every command is read-only" };
}

/** What one command in the chain does. */
function classifySegment(segment: string): CommandClassification {
  const parsed = parseCommand(segment);
  if (!parsed) {
    return { safety: "risky", reason: "could not parse command" };
  }
  const { command, args } = parsed;

  const riskyFlags = CONDITIONAL_SAFE[command];
  if (riskyFlags) {
    for (const pattern of riskyFlags) {
      if (pattern.test(segment)) {
        return { safety: "risky", reason: `"${command}" with a mutating flag` };
      }
    }
    return { safety: "safe", reason: `"${command}" without mutating flags` };
  }

  const rule = SUBCOMMAND_RULES[command];
  if (rule) {
    if (rule.mutating?.test(segment)) {
      return { safety: "risky", reason: `"${command}" with a mutating flag` };
    }
    if (reportsOnly(rule, args)) {
      const form = args[0] === undefined ? command : `${command} ${args[0]}`;
      return { safety: "safe", reason: `"${form}" only reports` };
    }
    return { safety: "risky", reason: `"${command}" changes state with that subcommand` };
  }

  if (ALWAYS_RISKY.has(command)) {
    return { safety: "risky", reason: `"${command}" is a mutating command` };
  }

  if (ALWAYS_SAFE.has(command)) {
    return { safety: "safe", reason: `"${command}" is read-only` };
  }

  // Unknown command. err on the side of caution
  return { safety: "risky", reason: `"${command}" is not in the safe command list` };
}
