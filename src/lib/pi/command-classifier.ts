/**
 * What a shell command does, for the two questions the approval gate asks.
 *
 * `classifyCommand` answers "does this change anything": the infra_exec and bash
 * "auto" policy runs a read and asks about a mutation.
 *
 * `escapesWorkspace` answers "can this reach past the workspace": a coder chat's
 * policy, where editing files is the job and only leaving the workspace asks.
 *
 * Both are heuristics over the command text. Each parses the command itself and
 * when in doubt errs towards asking.
 */

import { resolveWithinRoot } from "@/lib/files/paths";

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

  // Text processing (read-only)
  "grep",
  "egrep",
  "fgrep",
  "awk",
  "sort",
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

  // File/directory info (read-only)
  "file",
  "stat",
  "identify",

  // System info
  "uname",
  "uptime",
  "date",
  "whoami",
  "id",
  "groups",
  "hostname",
  "domainname",

  // Disk/memory info
  "df",
  "du",
  "free",
  "vmstat",

  // Process/network info
  "ps",
  "pgrep",
  "pidof",
  "top",
  "htop",
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

// ─── Conditionally safe commands ────────────────────────────────────────────

/**
 * Commands that are safe only without dangerous flags.
 * Maps command → set of risky flag patterns (matched against the full command string).
 */
const CONDITIONAL_SAFE: Record<string, RegExp[]> = {
  sed: [/-i(\s|$)/, /-\s*i(\s|$)/, /--in-place\b/],
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

// ─── Risky patterns ─────────────────────────────────────────────────────────

/** Commands that are always risky (destructive, mutating, or privileged). */
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

  // Package management
  "apt",
  "apt-get",
  "aptitude",
  "yum",
  "dnf",
  "pacman",
  "pip",
  "pip3",
  "npm",
  "yarn",
  "pnpm",
  "cargo",
  "go",
  "gem",
  "composer",

  // Service management
  "systemctl",
  "service",
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

  // Cron
  "crontab",

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

/** Patterns in the full command string that indicate risk. */
const RISKY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Append redirect (>>)
  { pattern: /\s>>\s/, reason: "append redirect (>>)" },
  // Overwrite redirect (>). but not >>
  { pattern: /\s>\s*(?!>)/, reason: "overwrite redirect (>)" },
  // Here-docs (can be used to create files)
  { pattern: /<<-?\s*['"]?EOF['"]?/, reason: "here-document" },
  // Subshell execution
  { pattern: /\$\(/, reason: "command substitution" },
  { pattern: /`[^`]+`/, reason: "backtick substitution" },
  // Pipe to a risky command
  {
    pattern: /\|\s*(sudo|rm|sh|bash|zsh|fish|curl|wget|python|node|xargs\s+rm)/,
    reason: "pipe to risky command",
  },
];

// ─── Classification ─────────────────────────────────────────────────────────

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
  for (const segment of commandSegments(command)) {
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

/** One command per entry, so a `&&` chain is read in full rather than at its first word. */
function commandSegments(command: string): string[] {
  return command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter((segment) => segment.trim() !== "");
}

/** The words of one segment, quotes stripped. */
function wordsOf(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .filter((word) => word !== "");
}

/**
 * Commands that hand their arguments to another command, so the word after them
 * is a command too: `ls | xargs gh pr list` reaches the network.
 */
const WRAPPERS = new Set([
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
const WRAPPER_ARGUMENT = /^-|^\d+(\.\d+)?[smh]?$/;

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

    const isArgument = WRAPPER_ARGUMENT.test(word) || word.includes("=");
    if (expectCommand && !isArgument) words.push(word);
    // A wrapper is still waiting for its own command.
    expectCommand = WRAPPERS.has(word) || (expectCommand && isArgument);
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

export type CommandSafety = "safe" | "risky";
export type CommandClassification = {
  safety: CommandSafety;
  reason: string;
};

/**
 * Classify a shell command as safe or risky.
 *
 * Safe: read-only operations (ls, cat, grep, system info, etc.)
 * Risky: anything that modifies state, deletes data, escalates privileges, etc.
 *
 * When in doubt, classifies as "risky".
 */
export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return { safety: "safe", reason: "empty command" };
  }

  // Check risky patterns first (redirects, subshells, pipes to risky commands)
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safety: "risky", reason };
    }
  }

  // Extract the base command (first word, stripping leading env vars and path)
  const baseCommand = extractBaseCommand(trimmed);
  if (!baseCommand) {
    return { safety: "risky", reason: "could not parse command" };
  }

  // Check always risky
  if (ALWAYS_RISKY.has(baseCommand)) {
    return { safety: "risky", reason: `"${baseCommand}" is a mutating command` };
  }

  // Check conditionally safe
  const riskyPatterns = CONDITIONAL_SAFE[baseCommand];
  if (riskyPatterns) {
    for (const pattern of riskyPatterns) {
      if (pattern.test(trimmed)) {
        return { safety: "risky", reason: `"${baseCommand}" with mutating flag` };
      }
    }
    return { safety: "safe", reason: `"${baseCommand}" without mutating flags` };
  }

  // Check always safe
  if (ALWAYS_SAFE.has(baseCommand)) {
    return { safety: "safe", reason: `"${baseCommand}" is read-only` };
  }

  // Unknown command. err on the side of caution
  return { safety: "risky", reason: `"${baseCommand}" is not in the safe command list` };
}

/**
 * Extract the base command name from a command string.
 * Strips leading environment variables (VAR=value cmd), paths (/usr/bin/cmd → cmd),
 * and wrapper commands (timeout, nice).
 */
function extractBaseCommand(cmd: string): string | null {
  // Split on shell metacharacters to get tokens
  const tokens = cmd.replace(/>>|>>|>>/g, " ").split(/\s+/);

  let i = 0;
  // Skip environment variable assignments (VAR=value)
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token || !/=/.test(token) || token.startsWith("=")) break;
    i++;
  }

  if (i >= tokens.length) return null;

  const firstToken = tokens[i];
  if (!firstToken) return null;

  let command = firstToken;

  // Strip path
  const slashIdx = command.lastIndexOf("/");
  if (slashIdx >= 0) {
    command = command.slice(slashIdx + 1);
  }

  // Strip wrapper commands (timeout, nice, ionice, nohup, env)
  // These may have arguments before the actual command (e.g., "timeout 30s ls")
  const wrappers = new Set(["timeout", "nice", "ionice", "nohup", "env"]);
  if (wrappers.has(command)) {
    // Skip wrapper's own arguments to find the real command
    let j = i + 1;
    while (j < tokens.length) {
      const next = tokens[j];
      if (!next) break;
      // Stop at the first token that looks like a command (not a flag, not a number/duration)
      if (!next.startsWith("-") && !/^\d+(\.\d+)?[smh]?$/.test(next)) {
        command = next;
        const slashIdx2 = command.lastIndexOf("/");
        if (slashIdx2 >= 0) {
          command = command.slice(slashIdx2 + 1);
        }
        break;
      }
      j++;
    }
  }

  return command || null;
}
