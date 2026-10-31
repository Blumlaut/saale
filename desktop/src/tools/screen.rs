//! Looking at the screen.
//!
//! A capture comes back with the display it is of and the factor it was scaled
//! by, because the pointer tools take coordinates in that image's space. The
//! model never has to think in desktop pixels.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use super::{Content, ToolResult, ToolSpec};
use crate::backends::Desktop;

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "screenshot",
            description:
                "Capture a display. Returns the image and the metadata a click maps through: the \
                 display's id, its origin and size on the desktop, and the image's own size.",
            schema: json!({
                "type": "object",
                "properties": {
                    "monitor": {
                        "type": "string",
                        "description": "Display id from a previous capture, or its name. The primary display when omitted."
                    }
                }
            }),
        },
        ToolSpec {
            name: "list_windows",
            description:
                "List the windows on this desktop, with their titles, applications and bounds.",
            schema: json!({ "type": "object", "properties": {} }),
        },
    ]
}

pub fn screenshot(desktop: &Desktop, args: &Value) -> Result<ToolResult, String> {
    let monitor = args.get("monitor").and_then(Value::as_str);
    let shot = desktop.capture(monitor)?;

    let metadata = json!({
        "monitor": shot.display.id,
        "name": shot.display.name,
        "origin": { "x": shot.display.x, "y": shot.display.y },
        "size": { "width": shot.display.width, "height": shot.display.height },
        "scale": shot.display.scale,
        "image": { "width": shot.image_width, "height": shot.image_height },
    });

    Ok(ToolResult {
        content: vec![
            Content::Image {
                mime: "image/png".to_string(),
                base64: STANDARD.encode(&shot.png),
            },
            Content::Text(metadata.to_string()),
        ],
        is_error: false,
    })
}

pub fn list_windows(desktop: &Desktop) -> Result<ToolResult, String> {
    let windows = desktop.windows()?;
    if windows.is_empty() {
        return Ok(ToolResult::text("This desktop has no windows open."));
    }

    let rows: Vec<Value> = windows
        .into_iter()
        .map(|window| {
            json!({
                "id": window.id,
                "title": window.title,
                "app": window.app,
                "bounds": {
                    "x": window.x,
                    "y": window.y,
                    "width": window.width,
                    "height": window.height,
                },
                "focused": window.focused,
            })
        })
        .collect();

    Ok(ToolResult::text(
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string()),
    ))
}
