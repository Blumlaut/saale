//! The pointer and the keyboard.
//!
//! Coordinates are the ones in the last screenshot of that display. The backend
//! maps them onto the desktop, so a click lands where the model pointed even
//! when the image it saw was scaled down.

use serde_json::{json, Value};

use super::{ToolResult, ToolSpec};
use crate::backends::Desktop;

pub fn mouse_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "click",
            description: "Click at a point in the last screenshot's coordinates.",
            schema: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "monitor": { "type": "string", "description": "Display id. The primary display when omitted." },
                    "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "left by default" }
                },
                "required": ["x", "y"]
            }),
        },
        ToolSpec {
            name: "double_click",
            description: "Double-click at a point in the last screenshot's coordinates.",
            schema: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "monitor": { "type": "string" }
                },
                "required": ["x", "y"]
            }),
        },
        ToolSpec {
            name: "move",
            description: "Move the pointer without clicking, for hover menus and tooltips.",
            schema: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "monitor": { "type": "string" }
                },
                "required": ["x", "y"]
            }),
        },
        ToolSpec {
            name: "drag",
            description: "Press at one point, move to another, and release.",
            schema: json!({
                "type": "object",
                "properties": {
                    "from_x": { "type": "number" },
                    "from_y": { "type": "number" },
                    "to_x": { "type": "number" },
                    "to_y": { "type": "number" },
                    "monitor": { "type": "string" }
                },
                "required": ["from_x", "from_y", "to_x", "to_y"]
            }),
        },
        ToolSpec {
            name: "scroll",
            description: "Scroll at a point. Positive scrolls down and right.",
            schema: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "dy": { "type": "integer", "description": "Vertical steps. Positive goes down." },
                    "dx": { "type": "integer", "description": "Horizontal steps. Positive goes right." },
                    "monitor": { "type": "string" }
                },
                "required": ["x", "y"]
            }),
        },
    ]
}

pub fn keyboard_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "type_text",
            description: "Type text into the focused window.",
            schema: json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        },
        ToolSpec {
            name: "press_key",
            description: "Press a key or a combination, written \"ctrl+shift+t\" or \"enter\".",
            schema: json!({
                "type": "object",
                "properties": { "keys": { "type": "string" } },
                "required": ["keys"]
            }),
        },
    ]
}

fn number(args: &Value, key: &str) -> Result<f64, String> {
    args.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("\"{key}\" is required"))
}

fn monitor(args: &Value) -> Option<&str> {
    args.get("monitor").and_then(Value::as_str)
}

pub fn mouse(desktop: &Desktop, name: &str, args: &Value) -> Result<ToolResult, String> {
    match name {
        "click" | "double_click" => {
            let x = number(args, "x")?;
            let y = number(args, "y")?;
            let button = match args.get("button").and_then(Value::as_str) {
                Some("right") => enigo::Button::Right,
                Some("middle") => enigo::Button::Middle,
                _ => enigo::Button::Left,
            };
            let times = if name == "double_click" { 2 } else { 1 };
            desktop.click(monitor(args), x, y, button, times)?;
            Ok(ToolResult::text(format!(
                "Clicked at {x}, {y} ({times}x, {button:?})"
            )))
        }
        "move" => {
            let x = number(args, "x")?;
            let y = number(args, "y")?;
            desktop.move_to(monitor(args), x, y)?;
            Ok(ToolResult::text(format!("Moved the pointer to {x}, {y}")))
        }
        "drag" => {
            let from = (number(args, "from_x")?, number(args, "from_y")?);
            let to = (number(args, "to_x")?, number(args, "to_y")?);
            desktop.drag(monitor(args), from, to)?;
            Ok(ToolResult::text(format!(
                "Dragged from {}, {} to {}, {}",
                from.0, from.1, to.0, to.1
            )))
        }
        "scroll" => {
            let x = number(args, "x")?;
            let y = number(args, "y")?;
            let dy = args.get("dy").and_then(Value::as_i64).unwrap_or(0) as i32;
            let dx = args.get("dx").and_then(Value::as_i64).unwrap_or(0) as i32;
            desktop.scroll(monitor(args), x, y, dy, dx)?;
            Ok(ToolResult::text(format!("Scrolled {dx}, {dy} at {x}, {y}")))
        }
        other => Err(format!("There is no tool called \"{other}\"")),
    }
}

pub fn keyboard(desktop: &Desktop, name: &str, args: &Value) -> Result<ToolResult, String> {
    match name {
        "type_text" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "\"text\" is required".to_string())?;
            desktop.type_text(text)?;
            Ok(ToolResult::text(format!(
                "Typed {} characters",
                text.chars().count()
            )))
        }
        "press_key" => {
            let keys = args
                .get("keys")
                .and_then(Value::as_str)
                .ok_or_else(|| "\"keys\" is required".to_string())?;
            desktop.press_key(keys)?;
            Ok(ToolResult::text(format!("Pressed {keys}")))
        }
        other => Err(format!("There is no tool called \"{other}\"")),
    }
}
