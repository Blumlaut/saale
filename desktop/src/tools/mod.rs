//! The tools this machine offers, and the groups they belong to.

mod files;
mod group;
mod png;
mod screen;
mod shell;

pub use group::{parse_list, Group};

use std::collections::BTreeSet;

use serde_json::{json, Value};

/// One tool, as MCP lists it.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

/// A block of a tool's answer.
pub enum Content {
    Text(String),
    Image { mime: String, base64: String },
}

impl Content {
    fn to_json(&self) -> Value {
        match self {
            Content::Text(text) => json!({ "type": "text", "text": text }),
            Content::Image { mime, base64 } => {
                json!({ "type": "image", "data": base64, "mimeType": mime })
            }
        }
    }
}

/// What a call produced.
pub struct ToolResult {
    pub content: Vec<Content>,
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(body: impl Into<String>) -> ToolResult {
        ToolResult {
            content: vec![Content::Text(body.into())],
            is_error: false,
        }
    }

    pub fn failed(body: impl Into<String>) -> ToolResult {
        ToolResult {
            content: vec![Content::Text(body.into())],
            is_error: true,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "content": self.content.iter().map(Content::to_json).collect::<Vec<_>>(),
            "isError": self.is_error,
        })
    }
}

/// Every tool the enabled groups contribute.
pub fn list(groups: &BTreeSet<Group>) -> Vec<ToolSpec> {
    let mut tools = Vec::new();

    if groups.contains(&Group::Screen) {
        tools.push(screen::screenshot_spec());
    }
    if groups.contains(&Group::Files) {
        tools.extend(files::specs());
    }
    if groups.contains(&Group::Terminal) {
        tools.push(shell::run_command_spec());
    }

    tools
}

/// Run one tool, refusing a group that is switched off.
pub async fn call(
    groups: &BTreeSet<Group>,
    name: &str,
    args: &Value,
) -> Result<ToolResult, String> {
    let group = group_of(name).ok_or_else(|| format!("There is no tool called \"{name}\""))?;
    if !groups.contains(&group) {
        return Err(format!(
            "The {} group is switched off on this computer",
            group.name()
        ));
    }

    match name {
        "screenshot" => screen::screenshot(args).await,
        "read_file" => files::read_file(args).await,
        "write_file" => files::write_file(args).await,
        "list_dir" => files::list_dir(args).await,
        "grep" => files::grep(args).await,
        "find" => files::find(args).await,
        "run_command" => shell::run_command(args).await,
        other => Err(format!("There is no tool called \"{other}\"")),
    }
}

fn group_of(name: &str) -> Option<Group> {
    match name {
        "screenshot" => Some(Group::Screen),
        "read_file" | "write_file" | "list_dir" | "grep" | "find" => Some(Group::Files),
        "run_command" => Some(Group::Terminal),
        _ => None,
    }
}
