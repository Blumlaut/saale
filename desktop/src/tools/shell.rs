//! Running a command on this machine.
//!
//! The terminal group is off by default, because this is the group that can do
//! anything the user can. When it is on, the command runs as them: no sandbox,
//! no allowlist. The timeout and the output cap are the only limits, and they
//! are there to keep one bad command from hanging a chat.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::{ToolResult, ToolSpec};

/// Long enough for a build, short enough that a hung command gives the turn back.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// How much of the output travels back.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

pub fn run_command_spec() -> ToolSpec {
    ToolSpec {
        name: "run_command",
        description:
            "Run a shell command on this computer and return its output. Runs as the user the \
             agent runs as, with no sandbox.",
        schema: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "cwd": { "type": "string", "description": "Directory to run in. The home directory when omitted." },
                "timeout_ms": {
                    "type": "integer",
                    "description": format!("How long to wait before killing it. {DEFAULT_TIMEOUT_MS} by default, {MAX_TIMEOUT_MS} at most.")
                }
            },
            "required": ["command"]
        }),
    }
}

pub async fn run_command(args: &Value) -> Result<ToolResult, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "\"command\" is required".to_string())?;
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());
    let timeout = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);

    let mut child = shell_command(command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("Cannot start the command: {err}"))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let waited = tokio::time::timeout(Duration::from_millis(timeout), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_end(&mut out).await;
        }
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_end(&mut err).await;
        }
        let status = child.wait().await;
        (out, err, status)
    })
    .await;

    let (out, err, status) = match waited {
        Ok(value) => value,
        Err(_) => {
            return Ok(ToolResult::failed(format!(
                "The command did not finish within {timeout} ms and was killed."
            )))
        }
    };

    let status = status.map_err(|err| format!("The command could not be waited on: {err}"))?;
    let body = json!({
        "exitCode": status.code(),
        "stdout": clip(&out),
        "stderr": clip(&err),
        "truncated": out.len() > MAX_OUTPUT_BYTES || err.len() > MAX_OUTPUT_BYTES,
    });

    Ok(ToolResult {
        content: vec![super::Content::Text(body.to_string())],
        is_error: !status.success(),
    })
}

fn clip(bytes: &[u8]) -> String {
    let slice = &bytes[..bytes.len().min(MAX_OUTPUT_BYTES)];
    String::from_utf8_lossy(slice).to_string()
}

#[cfg(unix)]
fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(windows)]
fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/C").arg(command);
    cmd
}
