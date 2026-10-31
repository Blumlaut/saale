/**
 * How a command reaches a remote shell.
 *
 * sshd hands an exec request's text to the machine's login shell, so the request
 * has to be written in whatever that shell understands: a POSIX shell on Unix,
 * cmd.exe on Windows. The command itself always arrives on stdin, which keeps it
 * out of the remote process list. A script that hunts for its own name
 * (`pkill -f health_scan.py`) would otherwise match the shell running it and
 * kill its own session mid-run.
 */

export type RemotePlatform = "posix" | "windows";

/**
 * A POSIX login shell reading a script from stdin.
 *
 * `$SHELL` because that is what ran commands before the wrapper existed, with a
 * fallback for an account that has none set.
 */
const POSIX_REQUEST = 'exec "${SHELL:-/bin/sh}" -s';

/**
 * cmd.exe reading a script from stdin. It does that when given neither /C nor
 * /K; /D skips the AutoRun commands a machine may have registered and /Q the
 * command echo.
 */
const WINDOWS_REQUEST = "cmd.exe /D /Q";

/**
 * The probe that names the platform.
 *
 * It calls `cmd.exe` rather than relying on the login shell, so a Windows box
 * whose default shell is PowerShell still answers: PowerShell runs it as a
 * native command. A POSIX shell reports the missing command instead and exits
 * non-zero. `%OS%` expands only under cmd, so the output confirms the answer.
 */
export const PLATFORM_PROBE = "cmd.exe /C echo %OS%";

/** A name a shell accepts on the left of an assignment. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Ends the heredoc that carries a file's content. Base64 cannot spell it. */
const WRITE_HEREDOC = "SAALE_WRITE_EOF";

/** cmd has no escape for these inside a quoted value. */
const WINDOWS_UNSAFE_VALUE = /["\r\n]/;

/** Options that shape the script, not the connection. */
export interface ScriptOptions {
  /** Working directory the command runs in. */
  cwd?: string;
  /** Environment variables, set by the script rather than by an SSH env request. */
  env?: Record<string, string>;
}

/** What the SSH client puts on the wire for one command. */
export interface ShellRequest {
  /** The exec request. Never contains the command. */
  request: string;
  /** The script the request's shell reads from stdin. */
  stdin: string;
}

/**
 * A caller's mistake in the options, as opposed to a command that failed.
 *
 * It rejects instead of coming back as a failed command, because the command
 * never ran.
 */
export class InvalidExecOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExecOptionsError";
  }
}

/** Single-quote a value so the POSIX shell passes it through unchanged. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a Windows value in double quotes, where cmd expands nothing. */
function windowsQuote(value: string, subject: string): string {
  if (WINDOWS_UNSAFE_VALUE.test(value)) {
    throw new InvalidExecOptionsError(
      `Cannot pass ${subject} to a Windows machine: "${value}" contains a quote or newline`,
    );
  }
  return `"${value}"`;
}

function posixScript(command: string, options: ScriptOptions): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(options.env ?? {})) {
    lines.push(`export ${name}=${posixQuote(value)}`);
  }

  // A directory that does not exist is a failed command, not a command that
  // silently runs somewhere else.
  if (options.cwd) lines.push(`cd ${posixQuote(options.cwd)} || exit 1`);

  lines.push(command);

  return lines.join("\n");
}

function windowsScript(command: string, options: ScriptOptions): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(options.env ?? {})) {
    lines.push(`set ${windowsQuote(`${name}=${value}`, `the value of ${name}`)}`);
  }

  if (options.cwd) {
    lines.push(`cd /d ${windowsQuote(options.cwd, "the working directory")}`);
    // `exit` rather than `exit /b`: there is no batch file to return from, so
    // only `exit` stops the shell and reports the failure.
    lines.push("if errorlevel 1 exit 1");
  }

  lines.push(command);

  // Hands the command's exit code back to sshd. cmd reads the script a line at a
  // time and expands `%ERRORLEVEL%` as it reads this one, so it is the code the
  // command left behind.
  lines.push("exit %ERRORLEVEL%");

  return lines.join("\r\n");
}

/**
 * Build the exec request and the script it reads.
 *
 * Environment variables travel inside the script rather than as an SSH env
 * request: sshd only accepts the names its `AcceptEnv` lists, so a request for
 * anything else is dropped without a word, while the script reaches every
 * process the command starts.
 */
export function buildShellRequest(
  platform: RemotePlatform,
  command: string,
  options: ScriptOptions = {},
): ShellRequest {
  for (const name of Object.keys(options.env ?? {})) {
    if (!VARIABLE_NAME.test(name)) {
      throw new InvalidExecOptionsError(`Invalid environment variable name: ${name}`);
    }
  }

  return {
    request: platform === "windows" ? WINDOWS_REQUEST : POSIX_REQUEST,
    stdin: platform === "windows" ? windowsScript(command, options) : posixScript(command, options),
  };
}

/**
 * Build a POSIX request that writes `content` to `filePath`.
 *
 * For machines whose SFTP session cannot be used. The content travels as base64
 * inside a heredoc, so no byte of it is read as shell syntax and no line of it
 * can end the heredoc early.
 */
export function buildWriteRequest(filePath: string, content: Buffer): ShellRequest {
  const base64 = content.toString("base64").replace(/(.{76})/g, "$1\n");
  const script = `base64 -d > ${posixQuote(filePath)} <<'${WRITE_HEREDOC}'\n${base64}\n${WRITE_HEREDOC}`;
  return buildShellRequest("posix", script);
}

/** Build a POSIX request that makes a directory and any parents it needs. */
export function buildMkdirRequest(dirPath: string): ShellRequest {
  return buildShellRequest("posix", `mkdir -p ${posixQuote(dirPath)}`);
}

/**
 * Read the platform off {@link PLATFORM_PROBE}'s answer.
 *
 * cmd.exe prints `Windows_NT` for `%OS%`, or the untouched `%OS%` when a machine
 * has no such variable. Anything else is a POSIX login shell, including a probe
 * that could not run at all.
 */
export function parsePlatformProbe(stdout: string, exitCode: number | null): RemotePlatform {
  // A null exit code means the server reported none, not that the probe failed.
  if (exitCode !== null && exitCode !== 0) return "posix";
  return /^(windows_nt|%os%)$/i.test(stdout.trim()) ? "windows" : "posix";
}
