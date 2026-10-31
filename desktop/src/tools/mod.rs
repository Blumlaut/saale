//! The tools this machine offers, and the groups they belong to.

mod files;
mod group;
mod input;
mod screen;
mod shell;

pub use group::{enabled, new_groups, parse_list, set_groups, toggle, Group, Groups};

use serde_json::{json, Value};

use crate::backends::Desktop;

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
///
/// A machine without a display has no screen and no pointer to offer, so those
/// groups contribute nothing even when they are switched on. The model never
/// sees a tool that could only fail.
pub fn list(groups: &Groups, display: bool) -> Vec<ToolSpec> {
    let groups = enabled(groups);
    let mut tools = Vec::new();

    if display && groups.contains(&Group::Screen) {
        tools.extend(screen::specs());
    }
    if display && groups.contains(&Group::Mouse) {
        tools.extend(input::mouse_specs());
    }
    if display && groups.contains(&Group::Keyboard) {
        tools.extend(input::keyboard_specs());
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
    desktop: &Desktop,
    groups: &Groups,
    name: &str,
    args: &Value,
) -> Result<ToolResult, String> {
    let group = group_of(name).ok_or_else(|| format!("There is no tool called \"{name}\""))?;
    if !enabled(groups).contains(&group) {
        return Err(format!(
            "The {} group is switched off on this computer",
            group.name()
        ));
    }

    match name {
        "screenshot" => screen::screenshot(desktop, args),
        "list_windows" => screen::list_windows(desktop),
        "click" | "double_click" | "move" | "drag" | "scroll" => {
            input::mouse(desktop, name, args).await
        }
        "type_text" | "press_key" => input::keyboard(desktop, name, args).await,
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
        "screenshot" | "list_windows" => Some(Group::Screen),
        "click" | "double_click" | "move" | "drag" | "scroll" => Some(Group::Mouse),
        "type_text" | "press_key" => Some(Group::Keyboard),
        "read_file" | "write_file" | "list_dir" | "grep" | "find" => Some(Group::Files),
        "run_command" => Some(Group::Terminal),
        _ => None,
    }
}
