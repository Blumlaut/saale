//! JSON-RPC, as the MCP client on the instance speaks it.
//!
//! Requests arrive over the channel and answers go back over it. The surface is
//! small on purpose: the instance lists this machine's tools, calls them, and
//! pings it.

use serde_json::{json, Value};

use crate::backends::Desktop;
use crate::tools;

pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub const SERVER_NAME: &str = "saale-agent";

/// Build the answer to one request, or nothing for a notification.
pub async fn handle(groups: &tools::Groups, desktop: &Desktop, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id").cloned();

    // A notification carries no id and takes no answer.
    let id = id?;

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": message
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": crate::VERSION },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tools::list(groups, desktop.available())
                .into_iter()
                .map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.schema,
                }))
                .collect::<Vec<_>>(),
        })),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match tools::call(desktop, groups, name, &arguments).await {
                Ok(result) => Ok(result.to_json()),
                Err(err) => Err((-32602, err)),
            }
        }
        other => Err((-32601, format!("Unknown method \"{other}\""))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    })
}

/// The hello the instance records: what this machine offers, and its version.
pub fn hello(groups: &tools::Groups, display: bool) -> Value {
    // Only what this machine can actually do: a group with no tools to offer is
    // not a capability, whatever the switch says.
    json!({
        "hello": {
            "capabilities": tools::enabled(groups)
                .iter()
                .filter(|group| !matches!(group, tools::Group::Screen | tools::Group::Mouse | tools::Group::Keyboard) || display)
                .map(|group| group.name())
                .collect::<Vec<_>>(),
            "agentVersion": crate::VERSION,
            "session": session(),
            "platform": std::env::consts::OS,
        }
    })
}

/// Which display server this session is on, which decides how the agent captures
/// and injects.
pub fn session() -> &'static str {
    match std::env::var("XDG_SESSION_TYPE") {
        Ok(kind) if kind.eq_ignore_ascii_case("wayland") => "wayland",
        Ok(kind) if kind.eq_ignore_ascii_case("x11") => "x11",
        _ => "unknown",
    }
}
