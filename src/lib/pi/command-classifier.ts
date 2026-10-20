/**
 * Classify shell commands as "safe" (read-only / navigation) or "risky" (mutating / destructive).
 *
 * Used by the infra_exec tool's "auto" approval policy to auto-approve safe commands
 * and require user approval for risky ones.
 *
 * This is a heuristic classifier. it parses the first command in a pipeline and checks
 * against known safe/risky patterns. When in doubt, it classifies as "risky".
 */

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
